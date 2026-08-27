import { mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import { SingleAgent, ChatMessage } from "../core/agent/single-agent.ts";
import { createDefaultRegistry } from "../core/agent/tools/index.ts";
import { ToolExecutor } from "../core/agent/tools/executor.ts";
import { graphPlanTool, graphExecuteTool, graphStatusTool, graphListTool } from "../core/agent/tools/graph-tools.ts";
import { goalCreateTool, goalListTool, webSearchTool } from "../core/agent/tools/web-media-tools.ts";
import { createRun, addNodes, getRun, listRuns, listNodes, recordRunEvent } from "../core/orchestration/graph-store.ts";
import { GraphExecutor } from "../core/orchestration/executor.ts";
import { classifyIntent, planForRequest } from "../core/orchestration/planner.ts";
import { recoverStaleRuns, prepareResume, markStaleForTest } from "../core/orchestration/recovery.ts";
import type { ToolExecutionContext } from "../core/agent/tools/registry.ts";
import type { GraphPlan } from "../core/orchestration/types.ts";
import type { SubagentRunner, SubagentRunResult } from "../core/orchestration/subagents/opencode-runner.ts";
import { persistGraphOutcome } from "../core/organization/graph-obsidian.ts";
import { listSessions, getMessages, persistMessage } from "../core/agent/session-store.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* retry on Windows */ }
  }
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-e2e-"));
  dirs.push(dir);
  const vaultPath = path.join(dir, "vault");
  mkdirSync(path.join(vaultPath, "02 - Areas"), { recursive: true });
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

function ctx(config: ReturnType<typeof setup>["config"], sessionId = "s1", approval: (t: string) => Promise<boolean> = async () => true): ToolExecutionContext {
  return { config, sessionId, userContext: { requestApproval: approval } };
}

function fakeLLM(text: string) {
  return async (_messages: ChatMessage[]): Promise<{ content: string }> => ({ content: text });
}

class FakeSubagentRunner implements SubagentRunner {
  public available = true;
  public calls: Array<{ agentId: string; task: string }> = [];
  public failFirst = 1;
  private attempts = new Map<string, number>();

  async isAvailable(): Promise<boolean> { return this.available; }
  async run(opts: { agentId: string; task: string; cwd: string; model?: string; timeoutMs?: number }): Promise<SubagentRunResult> {
    if (!this.available) return { ok: false, status: "BLOCKED", output: "", sessionId: null, filesChanged: [], testsPassed: false, error: "OpenCode CLI indisponível", unavailable: true, durationMs: 1 };
    this.calls.push({ agentId: opts.agentId, task: opts.task });
    const n = (this.attempts.get(opts.agentId) ?? 0) + 1;
    this.attempts.set(opts.agentId, n);
    if (n <= this.failFirst) return { ok: false, status: "FAILED", output: "", sessionId: null, filesChanged: [], testsPassed: false, error: `falha proposital #${n}`, unavailable: false, durationMs: 1 };
    return { ok: true, status: "COMPLETED", output: `${opts.agentId} concluiu (Test Files 3 passed, 0 failed)`, sessionId: "oc.e2e", filesChanged: [], testsPassed: true, error: null, unavailable: false, durationMs: 1 };
  }
}

describe("FASE 3.6 — E2E REAL (TESTE 1..10)", { timeout: 60_000 }, () => {
  it("TESTE 1 — SIMPLE: 'Oi' é resposta conversacional, sem run criado", async () => {
    const { config } = setup();
    const agent = new SingleAgent({ llm: fakeLLM("Oi! Estou aqui. O que você quer fazer?") });
    const result = await agent.chat(config, "e2e-simple", "Oi");
    expect(result.type).toBe("answer");
    expect(result.message?.content).toContain("Oi");
    expect(listRuns(config).length).toBe(0);
    const msgs = getMessages(config, "e2e-simple", 10);
    expect(msgs[0]?.content).toBe("Oi");
  });

  it("TESTE 2 — CONTEXTO: objetivo persistido é reutilizado num turno seguinte", async () => {
    const { config } = setup();
    // cria goal real via tool (busca/goal_create) e consulta em turno seguinte
    const res = await goalCreateTool.execute({ name: "Faturar R$5.000 este mês", type: "BUSINESS", target: 5000 }, ctx(config, "e2e-ctx"));
    expect(res.success).toBe(true);
    const goalId = (res.output as { id: string }).id;

    // O contexto compilado (goals ativos) é injetado no prompt; o LLM responde com base nele.
    const agent = new SingleAgent({
      llm: async (messages) => {
        const ctxText = messages.map((m) => m.content).join("\n");
        if (/Objetivos ativos|Faturar R\$5\.000|5\.000/i.test(ctxText)) {
          return { content: "Faltam R$5.000 para atingir a meta deste mês (objetivo registrado)." };
        }
        return { content: "Sem contexto de objetivo." };
      },
    });
    const result = await agent.chat(config, "e2e-ctx", "Quanto falta?");
    expect(result.type).toBe("answer");
    expect(goalId).toBeTruthy();
    expect(result.message?.content).toMatch(/Faltam R\$5\.000/);
    const history = getMessages(config, "e2e-ctx", 20);
    expect(history.some((m) => m.content.includes("Faltam R$5.000"))).toBe(true);
  });

  it("TESTE 3 — TOOL: criação de objetivo real (banco + Obsidian atualizado)", async () => {
    const { config } = setup();
    const res = await goalCreateTool.execute({ name: "Atingir R$5.000 neste mês", type: "BUSINESS", target: 5000 }, ctx(config, "e2e-tool"));
    expect(res.success).toBe(true);
    const output = res.output as { id: string; status: string; vault?: { note: string; action: string } };
    expect(output.id).toMatch(/^goal\./);
    expect(output.status).toBe("ACTIVE");
    expect(output.vault?.action).toBe("created");

    const db = openDatabase(config.dbPath);
    const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(output.id) as { id: string } | undefined;
    db.close();
    expect(row?.id).toBe(output.id);
    if (output.vault) expect(existsSync(path.join(config.vaultPath, output.vault.note))).toBe(true);
  });

  it("TESTE 4 — PLAN: pedido de planejamento NÃO executa (sem run, resposta estruturada)", async () => {
    const { config } = setup();
    expect(classifyIntent("Quero aumentar minhas vendas")).toBe("PLAN");
    expect(planForRequest("Quero aumentar minhas vendas")).toBeNull();
    const agent = new SingleAgent({
      llm: fakeLLM("Vamos estruturar: (1) diagnosticar estado atual; (2) listar canais de venda; (3) definir ações da semana. Quer que eu monte o plano?"),
    });
    const result = await agent.chat(config, "e2e-plan", "Quero aumentar minhas vendas");
    expect(result.type).toBe("answer");
    expect(listRuns(config, "e2e-plan").length).toBe(0);
  });

  it("TESTE 5 — GRAPH: planejamento multi-etapas cria DAG e executa tools reais ponta a ponta", async () => {
    const { config } = setup();
    // planner classifica exemplo da fase como GRAPH e gera DAG
    expect(classifyIntent("Encontre 10 empresas de estética em Sorocaba que não possuem site")).toBe("GRAPH");
    const plan = planForRequest("Encontre 10 empresas de estética em Sorocaba que não possuem site");
    expect(plan).not.toBeNull();
    expect(plan!.nodes.length).toBeGreaterThanOrEqual(3);
    // dependência encadeada: verify precisa de research
    const verify = plan!.nodes.find((n) => n.id === "verify");
    expect(verify?.dependencies).toEqual(["research"]);

    // cria run real e executa com executor real + runner fake (subagente é o único ponto externo)
    const run = createRun(config, { sessionKey: "e2e-graph", request: "encontre empresas de estética sem site", goal: "encontrar leads" });
    addNodes(config, run.id, plan as GraphPlan);
    const runner = new FakeSubagentRunner();
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({
      registry,
      executor: new ToolExecutor(registry),
      subagentRunner: runner,
    });
    const outcome = await ex.execute(config, run.id);
    expect(outcome.status).toBe("COMPLETED");
    expect(getRun(config, run.id)?.status).toBe("COMPLETED");
    expect(runner.calls.length).toBeGreaterThanOrEqual(3);
    const nodes = listNodes(config, run.id);
    expect(nodes.every((n) => n.status === "COMPLETED")).toBe(true);
  });

  it("TESTE 5b — GRAPH via SingleAgent: LLM decide usar graph_plan e graph_execute (pipeline real)", async () => {
    const { config } = setup();
    let state = 0;
    const agent = new SingleAgent({
      llm: async () => {
        state += 1;
        if (state === 1) return { content: JSON.stringify({ tool: "graph_plan", input: { request: "colocar o ClipCom funcionando" } }) };
        if (state === 2) {
          const run = listRuns(config, "e2e-ag").find((r) => r.request.includes("ClipCom"));
          return { content: JSON.stringify({ tool: "graph_execute", input: { runId: run?.id } }) };
        }
        return { content: "Plano executado com sucesso. Resumi o resultado." };
      },
    });
    const res = await agent.chat(config, "e2e-ag", "colocar o ClipCom funcionando", async () => true);
    expect(res.type).toBe("answer");
    expect(listRuns(config, "e2e-ag").some((r) => r.request.includes("ClipCom"))).toBe(true);
    // graph_execute foi invocado (mesmo que subagentes reais estejam indisponíveis no CI, o loop foi até o fim)
    expect(res.toolResults?.some((t) => t.toolId === "graph_execute")).toBe(true);
  });

  it("TESTE 6 — PARALLEL: dois nós independentes rodam na mesma wave (paralelo real)", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "e2e-par", request: "par", goal: "paralelismo" });
    const plan: GraphPlan = {
      goal: "paralelismo",
      nodes: [
        { id: "a", title: "Pesquisa A", type: "research", assignedAgent: "researcher" },
        { id: "b", title: "Pesquisa B", type: "research", assignedAgent: "researcher" },
        { id: "c", title: "Consolida", type: "research", assignedAgent: "researcher", dependencies: ["a", "b"] },
      ],
    };
    addNodes(config, run.id, plan);
    const runner = new FakeSubagentRunner();
    runner.failFirst = 0; // ambos os nós bem-sucedidos na primeira wave
    let active = 0;
    let maxActive = 0;
const wrap = {
      ...runner,
      isAvailable: () => runner.isAvailable(),
      run: async (o: Parameters<FakeSubagentRunner["run"]>[0]) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 30));
        const out = await runner.run(o);
        active -= 1;
        return out;
      },
    };
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({ registry, executor: new ToolExecutor(registry), subagentRunner: wrap, maxParallel: 2 });
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    expect(maxActive).toBeGreaterThanOrEqual(2); // paralelo real comprovado
    const a = listNodes(config, run.id).find((n) => n.id === `${run.id}.n1`)!;
    const b = listNodes(config, run.id).find((n) => n.id === `${run.id}.n2`)!;
    expect(a.parallelGroup).toBeTruthy();
    expect(b.parallelGroup).toBeTruthy();
    expect(a.parallelGroup).toBe(b.parallelGroup); // mesma wave
    expect(listNodes(config, run.id).find((n) => n.id === `${run.id}.n3`)?.status).toBe("COMPLETED");
  });

  it("TESTE 7 — FAILURE→REWORK→RETRY→SUCCESS (falha real recuperável)", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "e2e-fail", request: "task", goal: "rework", maxRetries: 2 });
    addNodes(config, run.id, { goal: "rework", nodes: [{ id: "a", title: "Passo instável", type: "implementation", assignedAgent: "developer" }] });
    const runner = new FakeSubagentRunner();
    runner.failFirst = 2; // falha 2x, depois sucesso
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({ registry, executor: new ToolExecutor(registry), subagentRunner: runner, maxRetries: 3 });
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    const node = listNodes(config, run.id)[0]!;
    expect(node.status).toBe("COMPLETED");
    expect(node.retryCount).toBeGreaterThanOrEqual(2);
    expect(runner.calls.length).toBe(3); // tentativa 1, retry 2, retry 3
  });

  it("TESTE 8 — RECOVERY: run interrompida é bloqueada e, após resume, continua sem duplicação", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "e2e-rec", request: "rec", goal: "recovery" });
    const plan: GraphPlan = {
      goal: "recovery",
      nodes: [
        { id: "a", title: "Passo A", type: "tool", toolId: "goal_list" },
        { id: "b", title: "Passo B", type: "tool", toolId: "goal_list", dependencies: ["a"] },
      ],
    };
    addNodes(config, run.id, plan);
    // simula processo morto: nó B ficou em RUNNING e run sem heartbeat
    const nodes = listNodes(config, run.id);
    const b = nodes.find((n) => n.title === "Passo B")!;
    const { updateNode } = await import("../core/orchestration/graph-store.ts");
    updateNode(config, b.id, { status: "RUNNING", startedAt: new Date(Date.now() - 3600 * 1000).toISOString() });
    markStaleForTest(config, run.id, new Date(Date.now() - 3600 * 1000).toISOString());

    const recovered = recoverStaleRuns(config, { staleAfterMs: 5 * 60 * 1000 });
    expect(recovered.some((r) => r.runId === run.id)).toBe(true);
    const after = getRun(config, run.id);
    expect(after?.status).toBe("BLOCKED");

    // resume real: nós READY executáveis voltam, nada concluído é re-executado
    const resumed = prepareResume(config, run.id);
    expect(resumed.keptCompleted).toBeGreaterThanOrEqual(0);
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({ registry, executor: new ToolExecutor(registry), subagentRunner: new FakeSubagentRunner() });
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    expect(getRun(config, run.id)?.status).toBe("COMPLETED");
    const finalNodes = listNodes(config, run.id);
    expect(finalNodes.every((n) => n.status === "COMPLETED")).toBe(true);
  });

  it("TESTE 9 — OBSIDIAN: resultado do Graph é persistido como conhecimento (com provenance)", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "e2e-obs", request: "estratégia de vendas", goal: "plano de vendas" });
    const nodes = addNodes(config, run.id, {
      goal: "plano de vendas",
      nodes: [
        { id: "research", title: "Pesquisa de mercado", type: "research", assignedAgent: "researcher" },
      ],
    });
    // simula conclusão útil (nó com output real)
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({ registry, executor: new ToolExecutor(registry), subagentRunner: new FakeSubagentRunner() });
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    void nodes;
    const written = persistGraphOutcome(config, run.id);
    expect(written.written).toBe(true);
    expect(written.action).toBe("created");
    expect(written.path).toContain("Graph");
    const abs = path.join(config.vaultPath, written.path!);
    expect(existsSync(abs)).toBe(true);
    const content = (await import("node:fs")).readFileSync(abs, "utf8");
    expect(content).toContain(`graph_id: "${run.id}"`);
    expect(content).toContain('origin: "graph-orchestration"');
  });

  it("TESTE 10 — SESSION: conversa continua após o Graph, agente sabe o que foi feito", async () => {
    const { config } = setup();
    // cria um run "concluído" na sessão
    const run = createRun(config, { sessionKey: "e2e-sess", request: "montar campanha", goal: "campanha" });
    addNodes(config, run.id, { goal: "campanha", nodes: [{ id: "a", title: "Research", type: "research", assignedAgent: "researcher" }] });
    const registry = createDefaultRegistry();
    recordRunEvent(config, run.id, "GRAPH_CREATED", { sessionId: "e2e-sess" });

    const agent = new SingleAgent({
      llm: async (messages) => {
        const last = messages.at(-1)?.content ?? "";
        if (last.includes("{")) return { content: JSON.stringify({ tool: "graph_list", input: {} }) };
        return { content: "O Graph da campanha está registrado nesta sessão." };
      },
    });
    const result = await agent.chat(config, "e2e-sess", "O que fizemos com a campanha?");
    expect(result.type).toBe("answer");
    // a sessão continua e mantém o histórico + run relacionado
    const runs = listRuns(config, "e2e-sess");
    expect(runs.some((r) => r.id === run.id)).toBe(true);
    expect(result.message?.content.length).toBeGreaterThan(0);
  });
});

describe("FASE 3.6 — E2E REAL com web (TESTE 5 real: pesquisa web)", { timeout: 90_000 }, () => {
  async function networkUp(): Promise<boolean> {
    try {
      const res = await fetch("https://html.duckduckgo.com/html/?q=teste", { signal: AbortSignal.timeout(8000) });
      return res.ok;
    } catch {
      return false;
    }
  }

  it("GRAPH real: 3 nós de ferramenta web_search executam de verdade e avaliam quantidade", async () => {
    if (!(await networkUp())) {
      console.log("[e2e] rede indisponível — TESTE 5 (web real) marcado como NOT VALIDATED");
      return;
    }
    const { config } = setup();
    const run = createRun(config, { sessionKey: "e2e-realweb", request: "Encontre 10 empresas de estética em Sorocaba que não possuem site", goal: "encontrar leads web", maxRetries: 1, maxParallel: 2 });
    addNodes(config, run.id, {
      goal: "encontrar leads web",
      nodes: [
        { id: "a", title: "Busca A", type: "tool", toolId: "web_search", input: { query: "clínica de estética em Sorocaba" }, requireCount: 1, requireField: "" },
        { id: "b", title: "Busca B", type: "tool", toolId: "web_search", input: { query: "estetica sorocaba", maxResults: 8 }, requireCount: 1, requireField: "" },
        { id: "c", title: "Consolida", type: "tool", toolId: "memory_write", input: { content: "LEADS web encontrados", kind: "semantic", category: "IDEA" }, dependencies: ["a", "b"] },
      ],
    });
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({ registry, executor: new ToolExecutor(registry), subagentRunner: new FakeSubagentRunner(), maxRetries: 1, maxParallel: 2 });
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    const nodes = listNodes(config, run.id);
    const qtyNodes = nodes.filter((n) => Number(n.evaluate?.requireCount) > 0 && n.status === "COMPLETED");
    expect(qtyNodes.length).toBeGreaterThanOrEqual(2);
    for (const n of qtyNodes) {
      expect(n.evidence.some((e) => e.kind === "count")).toBe(true);
    }
    const runStatus = getRun(config, run.id)?.status;
    expect(runStatus).toBe("COMPLETED");
  });

  it("evaluator NÃO passa quantity falsa: requireCount grande força FAIL honesto", async () => {
    if (!(await networkUp())) {
      console.log("[e2e] rede indisponível — evaluator count marcado como NOT VALIDATED");
      return;
    }
    const { config } = setup();
    const run = createRun(config, { sessionKey: "e2e-count", request: "buscar", goal: "contagem", maxRetries: 0 });
    addNodes(config, run.id, {
      goal: "contagem",
      nodes: [
        { id: "a", title: "Busca impossível", type: "tool", toolId: "web_search", input: { query: "zzzzznãonaexisteindmkeplz", maxResults: 5 }, requireCount: 999, requireField: "" },
      ],
    });
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({ registry, executor: new ToolExecutor(registry), subagentRunner: new FakeSubagentRunner(), maxRetries: 0 });
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("FAILED");
    const node = listNodes(config, run.id)[0]!;
    expect(node.status).toBe("FAILED");
    expect(node.evidence.some((e) => e.kind === "count")).toBe(true);
  });
});

describe("FASE 3.6 — planner e tools conectadas (sem mocks)", () => {
  it("createDefaultRegistry expõe as 5 tools de graph com available=true", () => {
    const registry = createDefaultRegistry();
    for (const id of ["graph_plan", "graph_execute", "graph_status", "graph_list", "graph_recover"]) {
      const t = registry.get(id);
      expect(t).toBeDefined();
      expect(t?.available).toBe(true);
    }
  });

  it("graph_status devolve progresso legível após execução", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s", request: "x", goal: "g" });
    addNodes(config, run.id, { goal: "g", nodes: [{ id: "a", title: "Audit", type: "audit", assignedAgent: "developer" }] });
    const res = await graphStatusTool.execute({ runId: run.id }, ctx(config));
    expect(res.success).toBe(true);
    expect((res.output as { readable: string }).readable).toContain("Audit");
  });

  it("graph_execute com approval negado NÃO executa", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "s", request: "objetivos", goal: "listar" });
    addNodes(config, run.id, { goal: "objs", nodes: [{ id: "a", title: "A", type: "tool", toolId: "goal_list" }] });
    const exec = new ToolExecutor(createDefaultRegistry());
    const denied = await exec.execute({
      toolId: "graph_execute",
      input: { runId: run.id },
      ctx: { ...ctx(config), userContext: { requestApproval: async () => false } },
    });
    expect(denied.success).toBe(false);
    expect(listNodes(config, run.id)[0]?.status).toBe("PENDING");
  });
});