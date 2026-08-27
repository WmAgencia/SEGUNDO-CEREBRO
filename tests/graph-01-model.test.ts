import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import { validateGraph } from "../core/orchestration/graph-validator.ts";
import {
  createRun,
  getRun,
  listRuns,
  addNodes,
  listNodes,
  getNode,
  updateNode,
  updateRunStatus,
  recordNodeEvent,
  nodeHistory,
} from "../core/orchestration/graph-store.ts";
import type { GraphPlan } from "../core/orchestration/types.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* retry on Windows */ }
  }
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-graph-"));
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

describe("core/orchestration/graph-validator", () => {
  it("aceita DAG válido", () => {
    const res = validateGraph([
      { id: "a", title: "Research", type: "research" },
      { id: "b", title: "Design", type: "design", dependencies: ["a"] },
      { id: "c", title: "Build", type: "implementation", dependencies: ["a", "b"] },
    ]);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });

  it("rejeita dependência desconhecida", () => {
    const res = validateGraph([
      { id: "a", title: "A", type: "task" },
      { id: "b", title: "B", type: "task", dependencies: ["ghost"] },
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("unknown node"))).toBe(true);
  });

  it("rejeita auto-dependência", () => {
    const res = validateGraph([{ id: "a", title: "A", type: "task", dependencies: ["a"] }]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("itself"))).toBe(true);
  });

  it("rejeita ciclo (A→B→A)", () => {
    const res = validateGraph([
      { id: "a", title: "A", type: "task", dependencies: ["b"] },
      { id: "b", title: "B", type: "task", dependencies: ["a"] },
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("cycle"))).toBe(true);
  });

  it("rejeita ids duplicados e títulos vazios", () => {
    const res = validateGraph([
      { id: "a", title: "A", type: "task" },
      { id: "a", title: "A2", type: "task" },
      { id: "b", title: "", type: "task" },
    ]);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("duplicate node id"))).toBe(true);
    expect(res.errors.some((e) => e.includes("empty title"))).toBe(true);
  });
});

describe("core/orchestration/graph-store", () => {
  it("cria run em PLANNED e persiste campos", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s1", request: "clipcom funcional", goal: "colocar clipcom funcionando", projectId: "project.clipcom" });
    expect(run.status).toBe("PLANNED");
    expect(run.projectId).toBe("project.clipcom");
    expect(run.id).toMatch(/^run\./);

    const got = getRun(config, run.id);
    expect(got?.sessionKey).toBe("s1");
    expect(got?.request).toBe("clipcom funcional");
  });

  it("lista runs por sessão", () => {
    const { config } = setup();
    createRun(config, { sessionKey: "sA", request: "x", goal: "g" });
    createRun(config, { sessionKey: "sA", request: "y", goal: "g2" });
    createRun(config, { sessionKey: "sB", request: "z", goal: "g3" });
    expect(listRuns(config, "sA").length).toBe(2);
    expect(listRuns(config).length).toBe(3);
  });

  it("addNodes converte dependências por título/id e persiste estados", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s1", request: "r", goal: "g" });
    const plan: GraphPlan = {
      goal: "g",
      nodes: [
        { id: "research", title: "Research", type: "research" },
        { id: "design", title: "Design", type: "design", dependencies: ["research"] },
        { id: "qa", title: "QA", type: "qa", dependencies: ["design"] },
      ],
    };
    const nodes = addNodes(config, run.id, plan);
    expect(nodes.length).toBe(3);
    const design = nodes.find((n) => n.title === "Design");
    expect(design?.dependencies).toEqual([`${run.id}.n1`]);
    // 'design' infere developer:
    const designNode = getNode(config, design!.id);
    expect(designNode?.assignedAgent).toBe("developer");
    expect(nodes.every((n) => n.status === "PENDING")).toBe(true);
  });

  it("updateNode persiste transições e evidência", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s1", request: "r", goal: "g" });
    addNodes(config, run.id, { goal: "g", nodes: [{ id: "a", title: "A", type: "tool", toolId: "brain_search" }] });
    const node = listNodes(config, run.id)[0]!;
    const updated = updateNode(config, node.id, {
      status: "COMPLETED",
      output: { rows: 3 },
      evidence: [{ kind: "tool_result", value: "3 resultados" }],
      completedAt: new Date().toISOString(),
    });
    expect(updated?.status).toBe("COMPLETED");
    expect(updated?.output?.rows).toBe(3);
    const reloaded = getNode(config, node.id);
    expect(reloaded?.status).toBe("COMPLETED");
    expect(reloaded?.evidence[0]?.value).toBe("3 resultados");
  });

  it("updateRunStatus finaliza com result", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s1", request: "r", goal: "g" });
    updateRunStatus(config, run.id, "COMPLETED", { summary: "ok" });
    const got = getRun(config, run.id);
    expect(got?.status).toBe("COMPLETED");
    expect(got?.completedAt).toBeTruthy();
    expect(got?.result?.summary).toBe("ok");
  });

  it("bloqueia inserir nodes duas vezes na mesma run", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s1", request: "r", goal: "g" });
    addNodes(config, run.id, { goal: "g", nodes: [{ id: "a", title: "A", type: "task" }] });
    expect(() =>
      addNodes(config, run.id, { goal: "g", nodes: [{ id: "b", title: "B", type: "task" }] }),
    ).toThrowError(/already has nodes/);
  });

  it("registra e recupera observabilidade em events (graph_node)", () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s1", request: "r", goal: "g" });
    const nodes = addNodes(config, run.id, { goal: "g", nodes: [{ id: "a", title: "A", type: "task" }] });
    const n = nodes[0]!;
    recordNodeEvent(config, run.id, n.id, "started");
    recordNodeEvent(config, run.id, n.id, "completed", { status: "COMPLETED" });
    const history = nodeHistory(config, run.id);
    expect(history.map((h) => h.event)).toEqual(["started", "completed"]);
  });
});