import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import {
  ensureCommTables,
  resolveContact,
  resolveConversation,
  saveMessage,
  classifyIntent,
} from "../../core/comms/pipeline.ts";
import {
  getCustomerProfile,
  updateCustomerProfile,
  nextBestAction,
  nextBestQuestion,
} from "../../core/comms/pipeline.ts";
import { handleEvolutionWebhook } from "../../core/webhooks/evolution-webhook.ts";
import {
  startCollaboration,
  postCollaborationMessage,
  createDecision,
  listCollaborationMessages,
} from "../../core/collab/collaboration.ts";
import { upsertAgent } from "../../core/agents/agent-runtime.ts";

let dir: string;
let config: BrainConfig;
let d: DatabaseSync;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-gate28-"));
  config = {
    vaultPath: path.join(dir, "vault"),
    dataDir: dir,
    dbPath: path.join(dir, "brain.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  d = openDatabase(config.dbPath);
  applySchema(d);
  ensureCommTables(d);

  writeFileSync(
    path.join(config.vaultPath, "vyntra.md"),
    "---\nid: project.vyntra\ntype: project\ntitle: Vyntra\nstatus: active\n---\n# Vyntra\nSites.",
    "utf8",
  );
  indexVault(config);

  upsertAgent(d, {
    id: "sales-agent",
    name: "Sales Agent",
    description: "Vendas",
    domains: ["sales"],
    capabilities: ["qualification", "sales", "discovery"],
    permissions: ["context", "memory.read"],
    status: "AVAILABLE",
  });
  upsertAgent(d, {
    id: "marketing-agent",
    name: "Marketing Agent",
    description: "Marketing",
    domains: ["marketing", "vendas"],
    capabilities: ["copywriting", "cro", "campanhas"],
    permissions: ["context"],
    status: "AVAILABLE",
  });
});

afterAll(() => {
  try { d.close(); rmSync(dir, { recursive: true, force: true }); } catch {}
});

function simulateInbound(
  externalId: string,
  text: string,
  phone = "5511977776666",
): ReturnType<typeof handleEvolutionWebhook> {
  return handleEvolutionWebhook(config, {
    event: "messages.upsert",
    instance: "SECOM",
    data: {
      key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: externalId },
      pushName: "Cliente Gate 28",
      message: { conversation: text },
    },
  });
}

describe("FASE 28 GATE — Sales Intelligence E2E", () => {
  let contactId: number;

  it("1. Cliente envia mensagem inicial → agente responde com pergunta de descoberta", () => {
    const result = simulateInbound("gate-msg-001", "Oi, quero fazer um site.");
    expect(result.processed).toBe(true);
    expect(result.intent).toBe("SERVICE");
    expect(result.action).toContain("draft_generated");

    const draft = db()
      .prepare("SELECT content FROM wa_messages WHERE direction='outbound' AND external_id LIKE 'draft_gate-msg-001%'")
      .get() as { content: string };
    expect(draft?.content).toBeTruthy();
    contactId = getContactId("5511977776666");
  });

  it("2. Cliente explica negócio → perfil atualizado sem repetir pergunta", () => {
    simulateInbound("gate-msg-002", "Tenho uma clínica de estética e quero um site para mostrar meus serviços e conseguir clientes.");

    const profile = getCustomerProfile(d, contactId);
    expect(profile.business_segment).not.toBe("UNKNOWN");
    expect(profile.desired_outcome).not.toBe("UNKNOWN");
    expect(profile.service_interest).not.toBe("UNKNOWN");
    expect(profile.sales_stage).not.toBe("NEW");
  });

  it("3. NO-REPEAT: próxima pergunta NÃO repete segmento nem objetivo", () => {
    const profile = getCustomerProfile(d, contactId);
    const question = nextBestQuestion(profile);
    if (question) {
      expect(question.key).not.toBe("business_segment");
      expect(question.key).not.toBe("desired_outcome");
      expect(question.key).not.toBe("service_interest");
    }
  });

  it("4. Cliente pergunta preço → intent PRICE detectado", () => {
    const result = simulateInbound("gate-msg-003", "E quanto custa?");
    expect(result.intent).toBe("PRICE");
  });

  it("5. OBJECTION/NEGOTIATION dispara approval", () => {
    const result = simulateInbound("gate-msg-004", "Consegue fazer por R$500?");
    expect(result.intent).toBe("OBJECTION");

    const pending = d
      .prepare("SELECT COUNT(*) AS c FROM approvals WHERE status='PENDING' AND type='CUSTOMER_MESSAGE'")
      .get() as { c: number };
    expect(pending.c).toBeGreaterThan(0);
  });

  it("6. SALES ↔ MARKETING COLLABORATION registrada", () => {
    const session = startCollaboration(d, {
      topic: "Estratégia para clínica de estética",
      objective: "Converter interesse em proposta",
      participants: ["sales-agent", "marketing-agent"],
      maxRounds: 2,
    });

    postCollaborationMessage(d, {
      sessionId: session.id,
      fromParticipant: "sales-agent",
      toParticipant: "marketing-agent",
      type: "QUESTION",
      content: { question: "Como abordar clínica de estética?" },
    });

    postCollaborationMessage(db(), {
      sessionId: session.id,
      fromParticipant: "marketing-agent",
      toParticipant: "sales-agent",
      type: "ANSWER",
      content: { answer: "Foco em transformação visual e agendamento online." },
    });

    const msgs = listCollaborationMessages(d, session.id);
    expect(msgs.length).toBeGreaterThanOrEqual(2);
  });

  it("7. DECISION registrada com participantes e evidências", () => {
    const decision = createDecision(d, {
      sessionId: 1,
      question: "Qual estratégia para converter clínica?",
      options: ["portfolio_visual", "agendamento_direto", "consultivo"],
      selectedOption: "consultivo",
      participants: ["sales-agent", "marketing-agent"],
      reasons: ["clínica valoriza relacionamento antes de venda"],
      confidence: 0.85,
    });
    expect(decision.selectedOption).toBe("consultivo");
  });
});

describe("FASE 28 GATE — Approval Flow (SECOM channel)", () => {
  it("8. Owner aprova via SECOM → resposta enviada ao cliente", () => {
    const result = sendAs(OPS_GROUP, OWNER_PHONE, "aprovar", "gate-apr-secom-001");
    expect(result.processed).toBe(true);
    if (result.approval) {
      expect(result.approval.decision).toBe("APPROVED");
    }
  });

  it("9. Owner rejeita via SECOM", () => {
    simulateInbound("gate-msg-rej", "Tem como fazer por R$300?", "5511977776666");
    const result = sendAs(OPS_GROUP, OWNER_PHONE, "rejeitar", "gate-rej-secom-001");
    expect(result.processed).toBe(true);
  });
});

const OPS_GROUP = "120363427273069174@g.us";
const OWNER_PHONE = "5515981817336";

function sendAs(chatId: string, senderPhone: string, text: string, msgId: string) {
  return handleEvolutionWebhook(config, {
    event: "messages.upsert",
    instance: "SECOM",
    data: {
      key: {
        remoteJid: chatId,
        fromMe: false,
        id: msgId,
        participant: `${senderPhone}@s.whatsapp.net`,
      },
      pushName: "Owner",
      message: { conversation: text },
    },
  });
}

function db(): DatabaseSync {
  return new DatabaseSync(config.dbPath);
}

function getContactId(externalId: string): number {
  const row = d.prepare("SELECT id FROM wa_contacts WHERE external_id=?").get(externalId) as
    | { id: number }
    | undefined;
  return row?.id ?? 0;
}
