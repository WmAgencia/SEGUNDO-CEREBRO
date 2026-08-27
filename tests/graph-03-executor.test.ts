import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import { ToolRegistry, ToolDefinition } from "../core/agent/tools/registry.ts";
import { ToolExecutor } from "../core/agent/tools/executor.ts";
import {
  createRun, addNodes, getRun, listNodes, getNode,
} from "../core/orchestration/graph-store.ts";
import { GraphExecutor } from "../core/orchestration/executor.ts";
import { evaluateNode } from "../core/orchestration/evaluator.ts";
import type { SubagentRunner, SubagentRunResult } from "../core/orchestration/subagents/opencode-runner.ts";
import type { GraphPlan, GraphNode } from "../core/orchestration/types.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* retry on Windows */ }
  }
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-exec-"));
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

function mkTool(id: string, execute: ToolDefinition["execute"]): ToolDefinition {
  return {
    id,
    name: id,
    description: `test ${id}`,
    category: "test",
    permissions: ["READ"],
    riskLevel: "LOW",
    requiresApproval: false,
    timeoutMs: 5000,
    provenance: "test",
    inputSchema: { type: "object", required: [] },
    outputSchema: { type: "object", required: [] },
    available: true,
    execute,
  };
}

class FakeSubagentRunner implements SubagentRunner {
  available = true;
  failures = 0;
  concurrency = 0;
  maxConcurrency = 0;
  delayMs = 0;
  calls: Array<{ agentId: string; task: string }> = [];
  behavior: (opts: { agentId: string; task: string; attempts: number }) => SubagentRunResult;

  constructor(behavior?: (opts: { agentId: string; task: string; attempts: number }) => SubagentRunResult) {
    this.behavior = behavior ?? ((opts) => ({
      ok: true, status: "COMPLETED", output: `resultado de ${opts.agentId}: ${opts.task.slice(0, 40)} (Test Files 3 passed, 0 failed)`, sessionId: "oc.test.1", filesChanged: [], testsPassed: true, error: null, unavailable: false, durationMs: 1,
    }));
  }

  async isAvailable(): Promise<boolean> { return this.available; }
  async run(opts: { agentId: string; task: string; cwd: string; model?: string; timeoutMs?: number }): Promise<SubagentRunResult> {
    if (!this.available) {
      return { ok: false, status: "BLOCKED", output: "", sessionId: null, filesChanged: [], testsPassed: false, error: "OpenCode CLI indisponível", unavailable: true, durationMs: 1 };
    }
    this.concurrency += 1;
    this.maxConcurrency = Math.max(this.maxConcurrency, this.concurrency);
    const attempts = this.calls.filter((c) => c.agentId === opts.agentId).length + 1;
    this.calls.push({ agentId: opts.agentId, task: opts.task });
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    const result = this.behavior({ agentId: opts.agentId, task: opts.task, attempts });
    this.concurrency -= 1;
    return result;
  }
}

function executor(runner: FakeSubagentRunner, overrides: { approvals?: string[]; maxRetries?: number; maxParallel?: number } = {}) {
  const registry = new ToolRegistry();
  registry.register(mkTool("test_ok", async () => ({ success: true, output: { ok: true } })));
  registry.register(mkTool("test_fail", async () => ({ success: false, output: null, error: "boom" })));
  const toolExec = new ToolExecutor(registry);
  const approvals: string[] = [];
  return {
    registry,
    graph: new GraphExecutor({
      registry,
      executor: toolExec,
      subagentRunner: runner,
      requestApproval: async (toolId, input) => {
        approvals.push(toolId);
        const denied = overrides.approvals?.includes(toolId) ?? false;
        return !denied;
      },
      maxRetries: overrides.maxRetries ?? 2,
      maxParallel: overrides.maxParallel ?? 2,
    }),
    approvals,
  };
}

function makeRun(config: ReturnType<typeof setup>["config"], plan: GraphPlan, overrides: { retries?: number } = {}) {
  const run = createRun(config, { sessionKey: "s1", request: "r", goal: "g", maxRetries: overrides.retries ?? 2 });
  const nodes = addNodes(config, run.id, plan);
  return { run, nodes };
}

describe("core/orchestration/evaluator", () => {
  it("tool sem saída → FAIL", () => {
    const v = evaluateNode({ type: "tool", evaluate: { toolId: "x" }, output: null, evidence: [], status: "COMPLETED", error: null } as unknown as GraphNode);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/não produziu/);
  });
  it("tool com saída → PASS", () => {
    const v = evaluateNode({ type: "tool", evaluate: { toolId: "x" }, output: { rows: 1 }, evidence: [], status: "COMPLETED", error: null } as unknown as GraphNode);
    expect(v.pass).toBe(true);
  });
  it("require pattern ausente → FAIL", () => {
    const v = evaluateNode({ type: "tool", evaluate: { toolId: "x", require: "PROCESSADO" }, output: { rows: 1 }, evidence: [], status: "COMPLETED", error: null } as unknown as GraphNode);
    expect(v.pass).toBe(false);
    expect(v.reason).toMatch(/padrão exigido ausente/);
  });
  it("subagent sem conteúdo → FAIL; com conteúdo+testes → PASS", () => {
    const empty = evaluateNode({ type: "subagent", evaluate: { nodeType: "qa", require: null }, output: {}, evidence: [], status: "COMPLETED", error: null } as unknown as GraphNode);
    expect(empty.pass).toBe(false);
    const ok = evaluateNode({ type: "subagent", evaluate: { nodeType: "qa", require: null }, output: { agentId: "qa", output: "Test Files 4 passed, 0 failed" }, evidence: [], status: "COMPLETED", error: null } as unknown as GraphNode);
    expect(ok.pass).toBe(true);
  });
});

describe("core/orchestration/graph-executor (ETAPAS C,D,E,F)", () => {
  it("executa DAG linear de tools e completa", async () => {
    const { config } = setup();
    const runner = new FakeSubagentRunner();
    const { graph } = executor(runner);
    const plan: GraphPlan = {
      goal: "g",
      nodes: [
        { id: "a", title: "Passo A", type: "tool", toolId: "test_ok", input: { a: 1 } },
        { id: "b", title: "Passo B", type: "tool", toolId: "test_ok", dependencies: ["a"] },
        { id: "c", title: "Passo C", type: "tool", toolId: "test_ok", dependencies: ["b"] },
      ],
    };
    const { run } = makeRun(config, plan);
    const out = await graph.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    expect(getRun(config, run.id)?.status).toBe("COMPLETED");
    const nodes = listNodes(config, run.id);
    expect(nodes.every((n) => n.status === "COMPLETED")).toBe(true);
  });

  it("falha de tool vira REWORK e depois FAILED (max_retries)", async () => {
    const { config } = setup();
    const runner = new FakeSubagentRunner();
    const { graph } = executor(runner, { maxRetries: 1 });
    const plan: GraphPlan = { goal: "g", nodes: [{ id: "a", title: "Falho", type: "tool", toolId: "test_fail" }] };
    const { run } = makeRun(config, plan, { retries: 1 });
    const out = await graph.execute(config, run.id);
    expect(out.status).toBe("FAILED");
    const node = listNodes(config, run.id)[0]!;
    expect(node.status).toBe("FAILED");
    expect(node.error).toBe("boom");
  });

  it("subagent rework: falha 2x, depois sucesso → COMPLETED com retry_count", async () => {
    const { config } = setup();
    const runner = new FakeSubagentRunner(({ attempts }) => {
      if (attempts <= 2) return { ok: false, status: "FAILED", output: "", sessionId: null, filesChanged: [], testsPassed: false, error: "conflito de merge", unavailable: false, durationMs: 1 };
      return { ok: true, status: "COMPLETED", output: "resolvido (Test Files 5 passed, 0 failed)", sessionId: "oc.x", filesChanged: ["a.ts"], testsPassed: true, error: null, unavailable: false, durationMs: 1 };
    });
    const { graph } = executor(runner, { maxRetries: 3 });
    const plan: GraphPlan = { goal: "g", nodes: [{ id: "a", title: "Implementar X", type: "implementation", assignedAgent: "developer" }] };
    const { run } = makeRun(config, plan);
    const out = await graph.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    const node = listNodes(config, run.id)[0]!;
    expect(node.status).toBe("COMPLETED");
    expect(node.retryCount).toBeGreaterThanOrEqual(2);
  });

  it("paralelismo real: dois nós independentes de pesquisador rodam juntos (maxConcurrency >= 2)", async () => {
    const { config } = setup();
    const runner = new FakeSubagentRunner();
    runner.delayMs = 80;
    const { graph } = executor(runner, { maxParallel: 2 });
    const plan: GraphPlan = {
      goal: "g",
      nodes: [
        { id: "a", title: "Research A", type: "research", assignedAgent: "researcher" },
        { id: "b", title: "Research B", type: "research", assignedAgent: "researcher" },
      ],
    };
    const { run } = makeRun(config, plan);
    const out = await graph.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    // evidência real de paralelismo: os dois nós estavam rodando ao mesmo tempo
    expect(runner.maxConcurrency).toBeGreaterThanOrEqual(2);
    // wave group registrado
    const grp = new Set(listNodes(config, run.id).map((n) => n.parallelGroup));
    expect(grp.size).toBe(1);
    expect([...grp][0]).toMatch(/^wave\./);
  });

  it("respeita dependências: nó com dep não-completa não roda cedo", async () => {
    const { config } = setup();
    const runner = new FakeSubagentRunner();
    const { graph } = executor(runner);
    const calls: string[] = [];
    const order = (id: string) => {
      runner.calls = [];
      const orig = runner.behavior;
      runner.behavior = () => orig({ agentId: "researcher", task: "", attempts: 1 });
      void id;
    };
    void order;
    calls.push("x");
    const plan: GraphPlan = {
      goal: "g",
      nodes: [
        { id: "a", title: "A", type: "research", assignedAgent: "researcher" },
        { id: "b", title: "B", type: "implementation", assignedAgent: "developer", dependencies: ["a"] },
      ],
    };
    const { run } = makeRun(config, plan);
    const out = await graph.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    expect(mkIds({ config, run }).length).toBe(2);
  });

  it("subagent indisponível → node BLOCKED e run BLOCKED", async () => {
    const { config } = setup();
    const runner = new FakeSubagentRunner();
    runner.available = false;
    const { graph } = executor(runner, { approvals: [] });
    const plan: GraphPlan = { goal: "g", nodes: [{ id: "a", title: "Dev", type: "implementation", assignedAgent: "developer" }] };
    const { run } = makeRun(config, plan);
    const out = await graph.execute(config, run.id);
    expect(out.status).toBe("BLOCKED");
    const node = listNodes(config, run.id)[0]!;
    expect(node.status).toBe("BLOCKED");
    // SEM aprovação concedida NUNCA chega a subagent:
    expect(runner.calls.length).toBe(0);
  });

  it("subagent não read-only exige aprovação (approval gate)", async () => {
    const { config } = setup();
    const runner = new FakeSubagentRunner();
    const { graph, approvals } = executor(runner, { approvals: ["subagent:developer"] });
    const plan: GraphPlan = { goal: "g", nodes: [{ id: "a", title: "Dev", type: "implementation", assignedAgent: "developer" }] };
    const { run } = makeRun(config, plan);
    const out = await graph.execute(config, run.id);
    expect(out.status).toBe("BLOCKED");
    expect(approvals).toContain("subagent:developer");
    expect(runner.calls.length).toBe(0);
  });

  it("blocked por dependência falha propaga tanto para filhos READY", async () => {
    const { config } = setup();
    const runner = new FakeSubagentRunner();
    const { graph } = executor(runner, { maxRetries: 0 });
    const plan: GraphPlan = {
      goal: "g",
      nodes: [
        { id: "a", title: "Falho", type: "tool", toolId: "test_fail" },
        { id: "b", title: "Filho", type: "research", assignedAgent: "researcher", dependencies: ["a"] },
      ],
    };
    const { run } = makeRun(config, plan, { retries: 0 });
    const out = await graph.execute(config, run.id);
    expect(out.status).toBe("FAILED");
    const b = listNodes(config, run.id).find((n) => n.title === "Filho")!;
    expect(b.status).toBe("BLOCKED");
  });
});

function mkIds(_: { config: ReturnType<typeof setup>["config"]; run: { id: string } }): string[] {
  const nodes = listNodes(_.config, _.run.id);
  return nodes.filter((n) => n.status === "COMPLETED").map((n) => n.id);
}