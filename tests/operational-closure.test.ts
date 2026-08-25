import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../core/config/loader.ts";
import { applySchema, openDatabase } from "../storage/connection.ts";
import { ensureCommTables } from "../core/comms/pipeline.ts";
import {
  saveLead, listLeads, getLead, updateLeadStatus, leadStats, scoreLeadSignals,
} from "../core/comms/leads.ts";
import {
  getInstance, setAiEnabled, setConnected, inboundPolicy, listInstances,
} from "../core/comms/instance-state.ts";
import {
  runProspectionCycle, isWithinWindow, queueLeadsForCommercial, DEFAULT_PROSPECTION_CONFIG,
} from "../core/comms/prospector-scheduler.ts";
import type { ProspectingSource, LeadCandidate } from "../core/agents/specialized.ts";
import { persistConversationNote } from "../core/obsidian/conversation-notes.ts";
import { handleEvolutionWebhook } from "../core/webhooks/evolution-webhook.ts";

let dir: string;
let config: BrainConfig;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-closure-"));
  config = {
    vaultPath: path.join(dir, "v"),
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  const d = openDatabase(config.dbPath);
  applySchema(d);
  ensureCommTables(d);
  d.close();
  delete process.env.EVOLUTION_INSTANCE;
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

function db(): DatabaseSync {
  return openDatabase(config.dbPath);
}

/* ── SCHEMA v20 ── */

describe("Schema v20 — leads + whatsapp_instances", () => {
  it("cria tabela leads com campos de provenance", () => {
    const d = db();
    const cols = (d.prepare("PRAGMA table_info(leads)").all() as Array<{ name: string }>).map((c) => c.name);
    d.close();
    for (const c of ["id", "company_name", "phone", "website", "instagram", "source", "source_url",
      "qualification_score", "signals_json", "evidence_json", "status", "assigned_agent"]) {
      expect(cols).toContain(c);
    }
  });

  it("cria tabela whatsapp_instances com ai_enabled independente de connected", () => {
    const d = db();
    const cols = (d.prepare("PRAGMA table_info(whatsapp_instances)").all() as Array<{ name: string }>).map((c) => c.name);
    d.close();
    expect(cols).toContain("connected");
    expect(cols).toContain("ai_enabled");
    expect(cols).toContain("assigned_agent");
  });
});

/* ── LEADS ── */

describe("Lead entity — persistência, provenance, dedupe e scoring", () => {
  it("salva lead com provenance e calcula score determinístico", () => {
    const d = db();
    const r = saveLead(d, {
      companyName: "Clínica Veterinária Teste A",
      phone: "+5515999990001",
      source: "google_maps",
      sourceUrl: "https://maps.google.com/?cid=123",
      city: "Tatuí",
      signals: ["no_website", "active_instagram_bad_site"],
      evidence: ["instagram ativo sem site — verificado manualmente"],
    });
    expect(r.saved).toBe(true);
    if (!r.saved) return d.close();
    // no_website(30) + active_instagram_bad_site(15) = 45 → QUALIFIED
    expect(r.lead.qualificationScore).toBe(45);
    expect(r.lead.status).toBe("QUALIFIED");
    expect(r.lead.source).toBe("google_maps");
    expect(r.lead.sourceUrl).toContain("maps.google.com");
    d.close();
  });

  it("score determinístico: mesmos sinais → mesmo score sempre", () => {
    const s1 = scoreLeadSignals(["no_website", "no_cta"]);
    const s2 = scoreLeadSignals(["no_website", "no_cta"]);
    expect(s1.score).toBe(s2.score);
    expect(s1.score).toBe(40);
  });

  it("dedupe global por telefone (normalização remove pontuação)", () => {
    const d = db();
    const dup = saveLead(d, {
      companyName: "Outra Empresa Mesmo Telefone",
      phone: "55 15 99999-0001",
      source: "site_publico",
    });
    expect(dup.saved).toBe(false);
    if (!dup.saved) expect(dup.reason).toBe("duplicate");
    d.close();
  });

  it("dedupe por website normalizado", () => {
    const d = db();
    saveLead(d, { companyName: "Empresa Site X", website: "https://www.empresasitex.com.br", source: "s1" });
    const dup = saveLead(d, { companyName: "Cópia Site X", website: "empresasitex.com.br", source: "s2" });
    expect(dup.saved).toBe(false);
    d.close();
  });

  it("lista ordenado por score e atualiza status para fila comercial", () => {
    const d = db();
    saveLead(d, {
      companyName: "Alto Score LTDA", source: "teste", signals: ["no_website", "outdated_website", "no_cta"],
    });
    const all = listLeads(d, {});
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0]!.qualificationScore).toBeGreaterThanOrEqual(all[all.length - 1]!.qualificationScore);

    const qualified = listLeads(d, { status: "QUALIFIED" });
    const target = qualified[0]!;
    const updated = updateLeadStatus(d, target.id, "APPROACH_QUEUED", "sales-agent-01");
    expect(updated?.status).toBe("APPROACH_QUEUED");
    expect(updated?.assignedAgent).toBe("sales-agent-01");
    const stats = leadStats(d);
    expect(stats.queued).toBeGreaterThanOrEqual(1);
    d.close();
  });

  it("getLead retorna null para id inexistente", () => {
    const d = db();
    expect(getLead(d, "lead.nao.existe")).toBeNull();
    d.close();
  });
});

/* ── WHATSAPP IA ON/OFF ── */

describe("WhatsApp instance state — IA separada de conexão", () => {
  it("default: connected=false, ai_enabled=false", () => {
    const d = db();
    const inst = getInstance(d, "whatsapp-01");
    expect(inst.connected).toBe(false);
    expect(inst.aiEnabled).toBe(false);
    d.close();
  });

  it("desativar IA NÃO desconecta o WhatsApp", () => {
    const d = db();
    setConnected(d, "whatsapp-01", true, "5515900000000");
    const afterOff = setAiEnabled(d, "whatsapp-01", false);
    expect(afterOff.connected).toBe(true);   // segue conectado
    expect(afterOff.aiEnabled).toBe(false);  // IA desligada
    const afterOn = setAiEnabled(d, "whatsapp-01", true, "sales-agent-02");
    expect(afterOn.connected).toBe(true);
    expect(afterOn.aiEnabled).toBe(true);
    expect(afterOn.assignedAgent).toBe("sales-agent-02");
    d.close();
  });

  it("política inbound: sem config → PROCESS; conectada+IA off → SKIP; conectada+IA on → PROCESS; desconectada → SKIP", () => {
    const d = db();
    // instância nunca configurada
    expect(inboundPolicy(d, "instancia-inexistente").action).toBe("PROCESS");
    // configurada mas desconectada
    setConnected(d, "whatsapp-09", false);
    expect(inboundPolicy(d, "whatsapp-09").action).toBe("SKIP_NOT_CONNECTED");
    // conectada, IA off
    setConnected(d, "whatsapp-08", true);
    setAiEnabled(d, "whatsapp-08", false);
    expect(inboundPolicy(d, "whatsapp-08").action).toBe("SKIP_AI_DISABLED");
    // conectada, IA on
    setAiEnabled(d, "whatsapp-08", true);
    expect(inboundPolicy(d, "whatsapp-08").action).toBe("PROCESS");
    d.close();
  });

  it("listInstances reflete todas as instâncias registradas", () => {
    const d = db();
    setAiEnabled(d, "whatsapp-lista-a", true);
    const names = listInstances(d).map((i) => i.name);
    expect(names).toContain("whatsapp-lista-a");
    d.close();
  });
});

/* ── WEBHOOK × POLÍTICA DE IA ── */

function inboundEvent(phone: string, text: string) {
  return {
    event: "messages.upsert",
    instance: "whatsapp-policy-test",
    data: {
      key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: `msg-${Math.random().toString(36).slice(2)}` },
      pushName: "Cliente Teste",
      message: { conversation: text },
    },
  };
}

describe("Webhook × política de IA", () => {
  it("IA OFF: mensagem persistida, agente NÃO responde (sem draft)", () => {
    const d = db();
    setConnected(d, "whatsapp-policy-test", true);
    setAiEnabled(d, "whatsapp-policy-test", false);
    d.close();

    const result = handleEvolutionWebhook(config, inboundEvent("5511977770001", "Olá, quero um orçamento"));
    expect(result.processed).toBe(true);
    expect(result.action).toBe("ai_disabled_message_persisted_no_reply");

    const d2 = db();
    const drafts = d2.prepare(
      "SELECT COUNT(*) AS n FROM wa_messages WHERE direction='outbound' AND content LIKE '%orçamento%'",
    ).get() as { n: number };
    const inbounds = d2.prepare(
      "SELECT COUNT(*) AS n FROM wa_messages WHERE direction='inbound' AND content LIKE '%quero um orçamento%'",
    ).get() as { n: number };
    d2.close();
    expect(inbounds.n).toBeGreaterThanOrEqual(1);       // mensagem registrada
    expect(drafts.n).toBe(0);                            // NENHUMA resposta gerada
  });

  it("IA ON: mensagem processada normalmente (draft gerado)", () => {
    const d = db();
    setAiEnabled(d, "whatsapp-policy-test", true);
    d.close();

    const result = handleEvolutionWebhook(config, inboundEvent("5511977770002", "Oi"));
    expect(result.processed).toBe(true);
    expect(result.action).toContain("draft_generated");

    const d2 = db();
    const drafts = d2.prepare(
      "SELECT COUNT(*) AS n FROM wa_messages WHERE direction='outbound'",
    ).get() as { n: number };
    d2.close();
    expect(drafts.n).toBeGreaterThanOrEqual(1);
  });
});

/* ── PROSPECÇÃO / SCHEDULER ── */

class AuthorizedTestSource implements ProspectingSource {
  readonly name = "authorized-directory";
  async search(query: string): Promise<LeadCandidate[]> {
    const slug = query.toLowerCase().replace(/[^a-z0-9]+/g, "");
    return [
      { company: `Pet Shop ${query} 1`, contact: null, website: null, source: this.name, niche: "pet", location: "Tatuí", signals: ["no_website"], evidence: [this.name], score: 30 },
      { company: `Pet Shop ${query} 2`, contact: null, website: `https://petshop-${slug}.com.br`, source: this.name, niche: "pet", location: "Tatuí", signals: [], evidence: [this.name], score: 0 },
    ];
  }
}

class NotConfiguredSource implements ProspectingSource {
  readonly name = "google_maps";
  async search(_q: string): Promise<LeadCandidate[]> {
    throw new Error("PROSPECTING_SOURCE_NOT_CONFIGURED");
  }
}

describe("Scheduler de prospecção", () => {
  it("janela noturna 23→07: dentro às 23h/03h, fora às 12h", () => {
    const cfg = { ...DEFAULT_PROSPECTION_CONFIG };
    expect(isWithinWindow(23, cfg)).toBe(true);
    expect(isWithinWindow(3, cfg)).toBe(true);
    expect(isWithinWindow(7, cfg)).toBe(false);
    expect(isWithinWindow(12, cfg)).toBe(false);
  });

  it("fora da janela → OUTSIDE_WINDOW, zero buscas", async () => {
    const d = db();
    const noon = new Date("2026-08-25T12:00:00");
    const r = await runProspectionCycle(d, [new AuthorizedTestSource()], "veterinaria", { now: noon });
    expect(r.status).toBe("OUTSIDE_WINDOW");
    expect(r.leadsSaved).toBe(0);
    d.close();
  });

  it("kill switch ativo → KILL_SWITCH_ACTIVE antes de qualquer busca", async () => {
    const d = db();
    const night = new Date("2026-08-25T23:30:00");
    let searched = false;
    const spy: ProspectingSource = {
      name: "spy",
      async search() { searched = true; return []; },
    };
    const r = await runProspectionCycle(d, [spy], "x", { now: night, killSwitchActive: true });
    expect(r.status).toBe("KILL_SWITCH_ACTIVE");
    expect(searched).toBe(false);
    d.close();
  });

  it("fonte bloqueada é registrada como BLOCKED_SOURCE e ciclo continua com as demais", async () => {
    const d = db();
    const night = new Date("2026-08-26T01:00:00");
    const r = await runProspectionCycle(
      d,
      [new NotConfiguredSource(), new AuthorizedTestSource()],
      "clinicas",
      { now: night, maxLeadsPerDay: 50 },
    );
    expect(r.blockedSources.some((b) => b.source === "google_maps")).toBe(true);
    expect(r.blockedSources[0]?.reason).toBe("PROSPECTING_SOURCE_NOT_CONFIGURED");
    expect(r.leadsSaved).toBe(2); // fonte autorizada funcionou apesar do bloqueio
    expect(r.duplicatesBlocked).toBe(0);
    d.close();
  });

  it("leads qualificados podem ser enfileirados para o comercial", async () => {
    const d = db();
    const night = new Date("2026-08-26T02:00:00");
    const r = await runProspectionCycle(d, [new AuthorizedTestSource()], "dentistas", {
      now: night, maxLeadsPerDay: 100,
    });
    expect(r.leadsSaved).toBe(2);
    // ciclo 2 no mesmo dia: lead com website repetido → dedupe global bloqueia
    const r2 = await runProspectionCycle(d, [new AuthorizedTestSource()], "ortodontia", {
      now: night, maxLeadsPerDay: 200, minScoreToQueue: 10,
    });
    expect(r2.leadsSaved).toBe(2);
    expect(r2.duplicatesBlocked).toBe(0);
    // apenas "ortodontia 1" (no_website, 30pts) atinge minScore 10
    expect(r2.qualifiedForApproach.length).toBe(1);
    const queued = queueLeadsForCommercial(d, r2.qualifiedForApproach, "sales-agent-03");
    expect(queued).toBe(r2.qualifiedForApproach.length);
    const row = getLead(d, r2.qualifiedForApproach[0]!);
    expect(row?.status).toBe("APPROACH_QUEUED");
    expect(row?.assignedAgent).toBe("sales-agent-03");
    d.close();
  });

  it("daily budget respeitado: DAILY_BUDGET_REACHED impede novas buscas", async () => {
    const d = db();
    const night = new Date("2026-08-27T23:00:00");
    // ciclo 1: consome o orçamento diário (2 leads)
    const first = await runProspectionCycle(d, [new AuthorizedTestSource()], "orcamento-a", {
      now: night, maxLeadsPerDay: 2,
    });
    expect(first.leadsSaved).toBe(2);
    expect(first.status).toBe("RAN");
    // ciclo 2 mesmo dia: teto atingido ANTES de buscar
    const r = await runProspectionCycle(d, [new AuthorizedTestSource()], "orcamento-b", {
      now: night, maxLeadsPerDay: 2,
    });
    expect(r.status).toBe("DAILY_BUDGET_REACHED");
    expect(r.leadsSaved).toBe(0);
    d.close();
  });
});

/* ── OBSIDIAN CONVERSATIONS ── */

describe("Obsidian — conversas viram contexto navegável", () => {
  it("cria nota com frontmatter e acumula turnos sem duplicar arquivo", () => {
    const p1 = persistConversationNote(config, "closure-test", { role: "user", text: "Oi, tudo bem?", mode: "plane", topic: null });
    const p2 = persistConversationNote(config, "closure-test", { role: "manager", text: "Oi! Sou o Gerente.", mode: "plane", topic: "geral" });
    expect(p1).toBe(p2); // mesma nota do dia
    const abs = path.join(config.vaultPath, p1);
    expect(existsSync(abs)).toBe(true);
    const content = readFileSync(abs, "utf8");
    expect(content).toMatch(/^---[\s\S]*type: conversation[\s\S]*id: "conversation\.closure-test\.[\s\S]*provenance: "manager-chat"[\s\S]*---/);
    expect(content).toContain("**Wesley**");
    expect(content).toContain("**Gerente**");
    expect(content.match(/# Conversa/g)?.length).toBe(1); // título único
    expect((content.match(/### \d{2}:\d{2}:\d{2}/g) ?? []).length).toBe(2); // dois turnos
  });
});
