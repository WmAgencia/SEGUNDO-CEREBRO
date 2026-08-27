import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import { SingleAgent, ChatMessage } from "../core/agent/single-agent.ts";
import { createDefaultRegistry } from "../core/agent/tools/index.ts";
import { graphPlanTool, graphExecuteTool, graphStatusTool } from "../core/agent/tools/graph-tools.ts";
import { createRun, addNodes, getRun, listRuns, listNodes } from "../core/orchestration/graph-store.ts";
import type { ToolExecutionContext } from "../core/agent/tools/registry.ts";
import type { GraphPlan } from "../core/orchestration/types.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* retry on Windows */ }
  }
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-g5-"));
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

function ctx(config: ReturnType<typeof setup>["config"], sessionId = "s1"): ToolExecutionContext {
  return { config, sessionId };
}

describe("graph tools via SingleAgent (ETAPA H — integração)", () => {
  it("conversa simples NÃO cria run de graph", async () => {
    const { config } = setup();
    const agent = new SingleAgent({ llm: async () => ({ content: "Oi! Estou aqui." }) });
    await agent.chat(config, "s1", "Ei");
    expect(listRuns(config, "s1").length).toBe(0);
  });

  it("pedido multi-etapas aciona graph_plan dentro do loop do SingleAgent", async () => {
    const { config } = setup();
    let call = 0;
    const llm = async (messages: ChatMessage[]) => {
      call += 1;
      if (call === 1) return { content: JSON.stringify({ tool: "graph_plan", input: { request: "Quero colocar o ClipCom funcionando" } }) };
      return { content: "Criei o plano com 6 nós (Audit → Verify). Quer que eu execute?" };
    };
    const agent = new SingleAgent({ llm });
    const result = await agent.chat(config, "s1", "Quero colocar o ClipCom funcionando");
    expect(result.type).toBe("answer");
    const runs = listRuns(config, "s1");
    expect(runs.some((r) => r.planner === "rule" && r.request.includes("ClipCom"))).toBe(true);
    const run = runs[0]!;
    expect(listNodes(config, run.id).length).toBeGreaterThanOrEqual(5);
    expect(run.status).toBe("PLANNED"); // ainda não executado
  });

  it("graph_plan em pedido simples retorna graph:false (sem criar run)", async () => {
    const { config } = setup();
    const res = await graphPlanTool.execute({ request: "qual o status do whatsapp?" }, ctx(config));
    expect(res.success).toBe(true);
    expect((res.output as { graph: boolean }).graph).toBe(false);
    expect(listRuns(config).length).toBe(0);
  });

  it("graph_execute executa run de tools REAIS (goal_list) ponta a ponta", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s1", request: "objetivos", goal: "listar objetivos", maxRetries: 1 });
    const plan: GraphPlan = {
      goal: "listar objetivos",
      nodes: [
        { id: "a", title: "Listar objetivos", type: "tool", toolId: "goal_list" },
      ],
    };
    const nodes = addNodes(config, run.id, plan);
    expect(nodes[0]!.assignedAgent).toBe("tool");

    const res = await graphExecuteTool.execute({ runId: run.id }, { ...ctx(config), userContext: { requestApproval: async () => true } });
    expect(res.success).toBe(true);
    expect((res.output as { status: string }).status).toBe("COMPLETED");
    expect(getRun(config, run.id)?.status).toBe("COMPLETED");
  });

  it("graph_execute tem approval gate NO ToolExecutor (canal recusa → não roda)", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s1", request: "objetivos", goal: "listar" });
    addNodes(config, run.id, { goal: "objs", nodes: [{ id: "a", title: "A", type: "tool", toolId: "goal_list" }] });

    // Aprovação negada no nível do ToolExecutor (como no loop do SingleAgent):
    const registry = createDefaultRegistry();
    const { ToolExecutor } = await import("../core/agent/tools/executor.ts");
    const exec = new ToolExecutor(registry);
    const denied = await exec.execute({
      toolId: "graph_execute",
      input: { runId: run.id },
      ctx: { ...ctx(config), userContext: { requestApproval: async () => false } },
    });
    expect(denied.success).toBe(false);
    expect(denied.error).toMatch(/rejeit|reject|block/i);
    const node = listNodes(config, run.id)[0]!;
    expect(node.status).toBe("PENDING"); // nada rodou

    // Aprovação concedida → executa:
    const allowed = await exec.execute({
      toolId: "graph_execute",
      input: { runId: run.id },
      ctx: { ...ctx(config), userContext: { requestApproval: async () => true } },
    });
    expect(allowed.success).toBe(true);
    expect(getRun(config, run.id)?.status).toBe("COMPLETED");
  });

  it("graph_status reporta progresso legível", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s1", request: "x", goal: "g" });
    addNodes(config, run.id, { goal: "g", nodes: [{ id: "a", title: "Audit", type: "audit", assignedAgent: "developer" }] });
    const res = await graphStatusTool.execute({ runId: run.id }, ctx(config));
    expect(res.success).toBe(true);
    expect((res.output as { readable: string }).readable).toContain("Audit");
    expect((res.output as { status: string }).status).toBe("PLANNED");
  });

  it("createDefaultRegistry expõe as ferramentas graph (sem mocks)", () => {
    const registry = createDefaultRegistry();
    for (const id of ["graph_plan", "graph_execute", "graph_status", "graph_list", "graph_recover"]) {
      const t = registry.get(id);
      expect(t).toBeDefined();
      expect(t?.available).toBe(true);
    }
  });
});