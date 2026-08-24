import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  it("TEST 1: 'Oi' → resposta conversacional natural", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = managerChat(cfg, "Oi", "test-1");
    expect(r.type).toBe("conversation");
    expect(r.message).not.toContain("nenhuma ação");
    expect(r.message).not.toContain("não mapeada");
    expect(r.intent).toBe("CHAT");
  });

  it("TEST 2: 'Tudo bem?' → resposta conversacional", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = managerChat(cfg, "Tudo bem?", "test-2");
    expect(r.message).not.toContain("nenhuma ação");
    expect(r.intent).toBe("CHAT");
  });

  it("TEST 3: 'Você consegue me ajudar?' → resposta positiva", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = managerChat(cfg, "Você consegue me ajudar?", "test-3");
    expect(r.message).toMatch(/Posso|Consigo/);
  });

  it("TEST 4: 'Estou pensando em aumentar vendas.' → conversa/ideia, NÃO executa", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = managerChat(cfg, "Estou pensando em aumentar vendas.", "test-4");
    expect(r.intent).toBe("IDEA");
    expect(r.requiresConfirmation).toBe(false);
    expect(r.actions).toHaveLength(0);
  });

  it("TEST 9: 'Pare tudo.' → kill switch", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = managerChat(cfg, "Pare tudo.", "test-9");
    expect(r.intent).toBe("STOP");
    expect(r.actions[0]?.status).toBe("executed");
  });

  it("TEST 10: 'Continue.' → resume", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = managerChat(cfg, "Continue.", "test-10");
    expect(r.intent).toBe("RESUME");
  });

  it("TEST 7+8: Goal → confirmação → execução", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "test-goal-flow";

    const proposal = managerChat(cfg, "Quero faturar R$5.000 até o final do mês.", session);
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.type).toBe("plan");
    expect(proposal.intent).toBe("GOAL_CREATION");

    const execution = managerChat(cfg, "Pode executar.", session);
    expect(execution.type).toBe("execution");
    expect(execution.actions.some(a => a.status === "executed")).toBe(true);

    const db2 = openDatabase(cfg.dbPath);
    const goals = db2.prepare("SELECT COUNT(*) AS n FROM goals WHERE name LIKE '%5.000%' OR name LIKE '%5000%' OR name LIKE '%faturar%'").get() as { n: number };
    db2.close();
    expect(goals.n).toBeGreaterThanOrEqual(1);
  });

  it("TEST 11: contexto multi-turno — confirmação após proposta", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "test-multi-turn";

    const p1 = managerChat(cfg, "Estou pensando em aumentar vendas.", session);
    expect(p1.intent).toBe("IDEA");
    expect(p1.message).not.toContain("nenhuma ação");

    const p2 = managerChat(cfg, "Principalmente pela prospecção.", session);
    expect(p2.message).not.toContain("nenhuma ação");

    const p3 = managerChat(cfg, "Quero faturar R$3.000.", session);
    expect(p3.requiresConfirmation).toBe(true);

    const p4 = managerChat(cfg, "Pode.", session);
    expect(p4.type).toBe("execution");
  });

  it("TEST: 'Qual nossa prioridade atual?' → status real", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const r = managerChat(cfg, "Qual nossa prioridade atual?", "test-status");
    expect(r.intent).toBe("STATUS");
    expect(r.message).toContain("goals");
  });

  it("TEST: 'Não' após proposta → NÃO executa", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const session = "test-no";
    managerChat(cfg, "Quero faturar R$1.000.", session);
    const r = managerChat(cfg, "Não, deixa pra depois.", session);
    expect(r.type).toBe("conversation");
    const db2 = openDatabase(cfg.dbPath);
    const goals = db2.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number };
    db2.close();
    expect(goals.n).toBe(0);
  });
});
