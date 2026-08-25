import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../core/config/loader.ts";
import { applySchema, openDatabase } from "../storage/connection.ts";
import { runAutonomousCycle, setKillSwitch } from "../core/autonomous/cycle.ts";
import { submitResult } from "../core/agents/agent-os.ts";
import { createInitiative } from "../core/goals/initiatives.ts";
import { startOrchestratorRun } from "../core/agents/runtime-ops.ts";

let dir: string;
let config: BrainConfig;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "runtime2b-"));
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
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

function db(): DatabaseSync {
  const d = openDatabase(config.dbPath);
  applySchema(d);
  return d;
}

/* ── F1 CORRIGIDO: kill switch persistido sobrevive a restart ── */
function clearKillKey(d: DatabaseSync): void {
  d.prepare("DELETE FROM index_metadata WHERE key='runtime.kill_switch'").run();
}

describe("Kill switch persistido em DB", () => {
  it("ativar com db grava em index_metadata; ciclo novo (novo processo) respeita", () => {
    const d = db();
    clearKillKey(d);
    setKillSwitch(true, d);
    // simula restart: memória zerada + nova conexão
    setKillSwitch(false); // limpa só a memória global
    const cycle = runAutonomousCycle(config);
    expect(cycle.status).toBe("BLOCKED");
    expect(cycle.observation).toBe("kill_switch_active");
    clearKillKey(d);
    d.close();
  });

  it("desativar com db limpa a persistência e o ciclo volta a trabalhar", () => {
    const d = db();
    setKillSwitch(true, d);
    setKillSwitch(false, d);
    const row = d.prepare("SELECT value FROM index_metadata WHERE key='runtime.kill_switch'").get() as { value: string };
    expect(row.value).toBe("0");
    // ciclo roda (pode ser BLOCKED por falta de goals, mas NÃO por kill switch)
    const cycle = runAutonomousCycle(config);
    expect(cycle.observation).not.toBe("kill_switch_active");
    clearKillKey(d);
    d.close();
  });

  it("setKillSwitch sem db mantém comportamento legado in-memory", () => {
    const d = db();
    clearKillKey(d);
    setKillSwitch(true); // sem db → não persiste
    const row = d.prepare("SELECT value FROM index_metadata WHERE key='runtime.kill_switch'").get() as { value: string } | undefined;
    expect(row).toBeUndefined();
    setKillSwitch(false);
    d.close();
  });
});

/* ── ORCHESTRATOR RUN: run real + heartbeat + evento de conclusão ── */
describe("startOrchestratorRun — runs reais por task", () => {
  it("cria RUNNING com heartbeat; finish grava COMPLETED e emite task.completed", () => {
    const d = db();
    const handle = startOrchestratorRun(d, { taskId: 555, agentId: "developer-02", initiativeId: "init-rx" });
    let row = d.prepare("SELECT state, heartbeat_at FROM agent_runs WHERE id=?").get(handle.runId) as { state: string; heartbeat_at: string | null };
    expect(row.state).toBe("RUNNING");
    expect(row.heartbeat_at).toBeTruthy();

    handle.beat();
    handle.finish("COMPLETED", { output: "trabalho concluído" });

    const doneRow = d.prepare("SELECT state FROM agent_runs WHERE id=?").get(handle.runId) as { state: string };
    expect(doneRow.state).toBe("COMPLETED");    const evt = d.prepare(
      "SELECT event_type FROM events WHERE subject='developer-02' ORDER BY id DESC LIMIT 1",
    ).get() as { event_type: string };
    expect(evt.event_type).toBe("task.completed");
    d.close();
  });

  it("finish FAILED emite task.failed — nunca sucesso artificial", () => {
    const d = db();
    const handle = startOrchestratorRun(d, { taskId: 556, agentId: "developer-03" });
    handle.finish("FAILED", { error: "boom" });
    const evt = d.prepare(
      "SELECT event_type, payload FROM events WHERE subject='developer-03' ORDER BY id DESC LIMIT 1",
    ).get() as { event_type: string; payload: string };
    expect(evt.event_type).toBe("task.failed");
    expect(JSON.parse(evt.payload).error).toBe("boom");
    const row = d.prepare("SELECT state FROM agent_runs WHERE id=?").get(handle.runId) as { state: string };
    expect(row.state).toBe("FAILED");
    d.close();
  });
});

/* ── EVALUATOR OBRIGATÓRIO p/ dev ── */
describe("required_review — QA independente obrigatório em iniciativas dev", () => {
  function seedDevInitiative(d: DatabaseSync): number {
    const init = createInitiative(d, { title: `dev-e2e-${Date.now()}`, status: "APPROVED" });
    d.prepare("UPDATE initiatives SET required_review=1 WHERE id=?").run(init.id);
    d.prepare(
      "INSERT INTO initiative_tasks (initiative_id, ordinal, title, status) VALUES (?, 1, 'implementar módulo', 'RUNNING')",
    ).run(init.id);
    const t = d.prepare("SELECT id FROM initiative_tasks WHERE initiative_id=? ORDER BY id DESC LIMIT 1").get(init.id) as { id: number };
    d.prepare("INSERT OR IGNORE INTO agents (id,name,status) VALUES ('developer-01','Dev01','AVAILABLE')").run();
    return t.id;
  }

  it("submitResult em iniciativa dev → WAITING + review PENDING para qa-agent", () => {
    const d = db();
    const taskId = seedDevInitiative(d);
    const r = submitResult(d, config, {
      taskId,
      agentId: "developer-01",
      summary: "módulo implementado",
      output: "Implementei o módulo completo com testes cobrindo os casos principais e build passando.",
    });
    expect(r.awaitingReview).toBe(true);
    // requestReview registra approval CONTENT + resultado fica PENDING de revisão
    const approval = d.prepare(
      "SELECT type FROM approvals WHERE task_id=? ORDER BY id DESC LIMIT 1",
    ).get(taskId) as { type: string } | undefined;
    expect(approval?.type).toBe("CONTENT");
    const result = d.prepare(
      "SELECT review_status FROM agent_results WHERE task_id=? ORDER BY id DESC LIMIT 1",
    ).get(taskId) as { review_status: string };
    expect(result.review_status).toBe("PENDING");
    const task = d.prepare("SELECT status FROM initiative_tasks WHERE id=?").get(taskId) as { status: string };
    expect(task.status).toBe("WAITING");
    d.close();
  });

  it("iniciativa SEM required_review mantém fluxo legado (conclusão direta)", () => {
    const d = db();
    const init = createInitiative(d, { title: `generic-${Date.now()}`, status: "APPROVED" });
    d.prepare(
      "INSERT INTO initiative_tasks (initiative_id, ordinal, title, status) VALUES (?, 1, 'tarefa genérica', 'RUNNING')",
    ).run(init.id);
    const t = d.prepare("SELECT id FROM initiative_tasks WHERE initiative_id=? ORDER BY id DESC LIMIT 1").get(init.id) as { id: number };
    d.prepare("INSERT OR IGNORE INTO agents (id,name,status) VALUES ('marketing-agent','Mkt','AVAILABLE')").run();

    const r = submitResult(d, config, {
      taskId: t.id,
      agentId: "marketing-agent",
      summary: "ok",
      output: "Conteúdo produzido e aprovado conforme briefing recebido anteriormente.",
    });
    expect(r.awaitingReview).toBe(false);
    const task = d.prepare("SELECT status FROM initiative_tasks WHERE id=?").get(t.id) as { status: string };
    expect(task.status).toBe("COMPLETED");
    d.close();
  });
});
