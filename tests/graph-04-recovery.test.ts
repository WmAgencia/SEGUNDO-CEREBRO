import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import { createRun, addNodes, updateNode, getRun, listNodes } from "../core/orchestration/graph-store.ts";
import { detectStaleRuns, recoverStaleRuns, markStaleForTest } from "../core/orchestration/recovery.ts";
import type { GraphPlan } from "../core/orchestration/types.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* retry on Windows */ }
  }
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-recover-"));
  dirs.push(dir);
  const vaultPath = path.join(dir, "vault");
  mkdirSync(vaultPath, { recursive: true });
  const config = {
    vaultPath,
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error" as LogLevel,
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1", model: "test" },
  };
  const db = openDatabase(config.dbPath);
  applySchema(db);
  db.close();
  return { dir, config };
}

function stalePlan(): GraphPlan {
  return { goal: "g", nodes: [{ id: "a", title: "A", type: "research", assignedAgent: "researcher" }] };
}

describe("core/orchestration/recovery (ETAPA G)", () => {
  it("não considera fresh como stale", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s", request: "r", goal: "g" });
    addNodes(config, run.id, stalePlan());
    expect(detectStaleRuns(config, { staleAfterMs: 60_000 }).length).toBe(0);
  });

  it("detecta run RUNNING antiga (sem heartbeat recente)", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s", request: "r", goal: "g" });
    addNodes(config, run.id, stalePlan());
    markStaleForTest(config, run.id, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    const stale = detectStaleRuns(config, { staleAfterMs: 5 * 60 * 1000 });
    expect(stale.some((s) => s.id === run.id)).toBe(true);
  });

  it("ignora runs COMPLETED/FAILED mesmo antigas", () => {
    const { config } = setup();
    const done = createRun(config, { sessionKey: "s", request: "r", goal: "g" });
    const db = openDatabase(config.dbPath);
    db.prepare("UPDATE graph_runs SET status = 'COMPLETED' WHERE id = ?").run(done.id);
    markStaleForTest(config, done.id, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    db.close();
    expect(detectStaleRuns(config, { staleAfterMs: 5 * 60 * 1000 }).length).toBe(0);
  });

  it("recoverStaleRuns bloqueia nós e run com motivo claro", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s", request: "r", goal: "g" });
    addNodes(config, run.id, stalePlan());
    // simula execução interrompida: nó em RUNNING
    const node = listNodes(config, run.id)[0]!;
    updateNode(config, node.id, { status: "RUNNING", startedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
    markStaleForTest(config, run.id, new Date(Date.now() - 3600 * 1000).toISOString());

    const recovered = recoverStaleRuns(config, { staleAfterMs: 5 * 60 * 1000 });
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.action).toBe("blocked");
    expect(recovered[0]!.affectedNodes).toBeGreaterThanOrEqual(1);

    const after = getRun(config, run.id);
    expect(after?.status).toBe("BLOCKED");
    const nodeAfter = listNodes(config, run.id)[0]!;
    expect(nodeAfter.status).toBe("BLOCKED");
    expect(nodeAfter.error).toMatch(/stale/);
  });

  it("recovery safe-by-default: nunca auto-retoma trabalho de risco", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s", request: "r", goal: "g" });
    addNodes(config, run.id, stalePlan());
    markStaleForTest(config, run.id, new Date(Date.now() - 24 * 3600 * 1000).toISOString());
    recoverStaleRuns(config, { staleAfterMs: 5 * 60 * 1000 });
    const after = getRun(config, run.id);
    expect(after?.status).toBe("BLOCKED");
    expect(after?.result?.recovery).toMatch(/revis[ãa]o humana/);
  });
});