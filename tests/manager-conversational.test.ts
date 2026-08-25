import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { managerChat } from "../core/hq/manager.ts";
import type { BrainConfig } from "../core/config/loader.ts";

let directory = "";
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ""; });

function config(): BrainConfig {
  directory = mkdtempSync(path.join(tmpdir(), "second-brain-mgr-"));
  const vaultPath = path.join(directory, "vault"); mkdirSync(vaultPath);
  return { vaultPath, dataDir: directory, dbPath: path.join(directory, "brain.db"), logLevel: "error", search: { defaultLimit: 10, maxLimit: 50 }, context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1", model: "test" } };
}

describe("Manager Conversacional", () => {
  it("TEST 1: 'Oi' → resposta conversacional natural", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = await managerChat(cfg, "Oi", "test-1");
    expect(r.message).not.toContain("nenhuma ação");
    expect(r.message).not.toContain("não mapeada");
  });

  it("TEST 2: 'Tudo bem?' → resposta conversacional", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = await managerChat(cfg, "Tudo bem?", "test-2");
    expect(r.message).not.toContain("nenhuma ação");
  });

  it("TEST 3: 'Você consegue me ajudar?' → resposta positiva", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = await managerChat(cfg, "Você consegue me ajudar?", "test-3");
    expect(r.message).toMatch(/Posso|Consigo/);
  });

  it("TEST 4: 'Estou pensando em aumentar vendas.' → conversa/ideia, NÃO executa", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = await managerChat(cfg, "Estou pensando em aumentar vendas.", "test-4");
    expect(r.requiresConfirmation).toBe(false);
    expect(r.actions).toHaveLength(0);
  });

  it("TEST 9: 'Pare tudo.' → kill switch", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = await managerChat(cfg, "Pare tudo.", "test-9");
    expect(r.actions[0]?.status).toBe("executed");
  });

  it("TEST 10: 'Continue.' → resume", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = await managerChat(cfg, "Continue.", "test-10");
    expect(r.intent).toBe("RESUME");
  });

  it("TEST 7+8: Goal → confirmação → execução", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "test-goal-flow";
    const proposal = await managerChat(cfg, "Quero faturar R$5.000 até o final do mês.", session);
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.type).toBe("plan");
    const execution = await managerChat(cfg, "Pode executar.", session);
    expect(execution.type).toBe("execution");
    expect(execution.actions.some(a => a.status === "executed")).toBe(true);
    const db2 = openDatabase(cfg.dbPath);
    const goals = db2.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number };
    db2.close();
    expect(goals.n).toBeGreaterThanOrEqual(1);
  });

  it("TEST 11: contexto multi-turno — confirmação após proposta", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "test-multi-turn";
    const p1 = await managerChat(cfg, "Estou pensando em aumentar vendas.", session);
    expect(p1.message).not.toContain("nenhuma ação");
    const p2 = await managerChat(cfg, "Principalmente pela prospecção.", session);
    expect(p2.message).not.toContain("nenhuma ação");
    const p3 = await managerChat(cfg, "Quero faturar R$3.000.", session);
    expect(p3.requiresConfirmation).toBe(true);
    const p4 = await managerChat(cfg, "Pode.", session);
    expect(p4.type).toBe("execution");
  });

  it("TEST: 'Qual nossa prioridade atual?' → status real", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = await managerChat(cfg, "Qual nossa prioridade atual?", "test-status");
    expect(r.message).toContain("goals");
  });

  it("TEST: 'Não' após proposta → NÃO executa", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "test-no";
    await managerChat(cfg, "Quero faturar R$1.000.", session);
    const r = await managerChat(cfg, "Não, deixa pra depois.", session);
    expect(r.type).toBe("conversation");
    const db2 = openDatabase(cfg.dbPath);
    const goals = db2.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number };
    db2.close();
    expect(goals.n).toBe(0);
  });

  it("TEST: Nutriva → consulta real com dados", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = await managerChat(cfg, "O que temos sobre o Nutriva?", "test-nutriva");
    expect(r.message).not.toContain("nenhuma ação");
    expect(r.message).toContain("Nutriva");
  });

  it("TEST: follow-up 'aprofunde' usa contexto anterior", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "test-followup";
    await managerChat(cfg, "O que temos sobre o Nutriva?", session);
    const r = await managerChat(cfg, "Aprofunde.", session);
    expect(r.message).not.toContain("nenhuma ação");
  });

  it("TEST design: pedido de imagem roteia para o Designer com task unica", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "test-design-flow";
    const proposal = await managerChat(cfg, "Designer, gere um logo para a Nutriva", session);
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.type).toBe("plan");
    expect(proposal.message).toMatch(/Gerar imagem/i);
    const execution = await managerChat(cfg, "Pode", session);
    expect(execution.type).toBe("execution");
    expect(execution.message).toContain("Designer Agent");
    const db2 = openDatabase(cfg.dbPath);
    const tasks = db2.prepare("SELECT title, assigned_agent FROM initiative_tasks ORDER BY id").all() as Array<{ title: string; assigned_agent: string | null }>;
    db2.close();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.title).toMatch(/^Gerar imagem:/i);
    expect(tasks[0]!.assigned_agent).toBe("designer-agent");
  });

  it("TEST video: pedido de video roteia para o Designer com task unica", async () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "test-video-flow";
    const proposal = await managerChat(cfg, "Designer, gere um video de promocao para a Nutriva", session);
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.type).toBe("plan");
    expect(proposal.message).toMatch(/Gerar v[íi]deo/i);
    const execution = await managerChat(cfg, "Pode", session);
    expect(execution.type).toBe("execution");
    expect(execution.message).toContain("Designer Agent");
    const db2 = openDatabase(cfg.dbPath);
    const tasks = db2.prepare("SELECT title, assigned_agent FROM initiative_tasks ORDER BY id").all() as Array<{ title: string; assigned_agent: string | null }>;
    db2.close();
    expect(tasks.length).toBe(1);
    expect(tasks[0]!.title).toMatch(/^Gerar v[íi]deo:/i);
    expect(tasks[0]!.assigned_agent).toBe("designer-agent");
  });
});
