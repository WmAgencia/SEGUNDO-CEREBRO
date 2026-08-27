/**
 * FASE 4 — OpenCode Graph Runtime REAL + Operação E2E.
 *
 * Tudo aqui executa DE VERDADE quando o ambiente permite:
 *  - ferramentas reais (web_search via rede, goal_list, memory_write);
 *  - OpenCode CLI real (opencode run) — quando falta capacidade de LLM, o
 *    resultado é FAILED honesto com evidência (nunca sucesso falso);
 *  - paralelismo provado por timestamps reais (sobreposição de intervalos),
 *    não por "async no código";
 *  - recovery real (interrupção → retomada só dos pendentes);
 *  - rework real (FAILED → evidência → REWORK → RETRY → SUCCESS).
 */

import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import type { BrainConfig } from "../core/config/loader.ts";
import { createRun, addNodes, getRun, listNodes, updateNode } from "../core/orchestration/graph-store.ts";
import { GraphExecutor } from "../core/orchestration/executor.ts";
import { ToolExecutor } from "../core/agent/tools/executor.ts";
import { createDefaultRegistry } from "../core/agent/tools/index.ts";
import { OpenCodeSubagentRunner, parseOpenCodeOutput } from "../core/orchestration/subagents/opencode-runner.ts";
import { recoverStaleRuns, prepareResume, markStaleForTest } from "../core/orchestration/recovery.ts";
import { persistGraphOutcome } from "../core/organization/graph-obsidian.ts";
import type { GraphPlan } from "../core/orchestration/types.ts";
import type { SubagentRunner, SubagentRunResult } from "../core/orchestration/subagents/opencode-runner.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
});

function setup(): { config: BrainConfig } {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-f4-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "vault"), { recursive: true });
  const config = {
    vaultPath: path.join(dir, "vault"),
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error" as LogLevel,
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1", model: "test" },
  } as BrainConfig;
  const db = openDatabase(config.dbPath);
  applySchema(db);
  db.close();
  return { config };
}

function executorFor(config: BrainConfig, runner: SubagentRunner, maxParallel = 3, maxRetries = 2) {
  const registry = createDefaultRegistry();
  return new GraphExecutor({ registry, executor: new ToolExecutor(registry), subagentRunner: runner, maxParallel, maxRetries });
}

/** Runner fake determinístico — usado SOMENTE para exercitar a mecânica do
 * executor quando o OpenCode real não tem capacidade. Não simula sucesso que o
 * ambiente não consegue produzir. */
class StubRunner implements SubagentRunner {
  calls: Array<{ agentId: string; task: string }> = [];
  failTimes = 0;
  private attempts = new Map<string, number>();
  async isAvailable() { return true; }
  async run(o: { agentId: string; task: string }): Promise<SubagentRunResult> {
    this.calls.push({ agentId: o.agentId, task: o.task });
    const n = (this.attempts.get(o.agentId) ?? 0) + 1;
    this.attempts.set(o.agentId, n);
    if (n <= this.failTimes) return { ok: false, status: "FAILED", output: "", sessionId: null, filesChanged: [], testsPassed: false, error: `falha simulada #${n}`, unavailable: false, durationMs: 1 };
    return { ok: true, status: "COMPLETED", output: `${o.agentId} concluiu com evidência (tests: 3 passed)`, sessionId: "ses_stub", filesChanged: ["a.ts"], testsPassed: true, error: null, unavailable: false, durationMs: 1 };
  }
}

function loadFirstGroqKey(): string {
  try {
    const envPath = path.resolve(process.cwd(), ".env.local");
    if (!existsSync(envPath)) return "";
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^GROQ_API_KEY_1\s*=\s*(.+)$/);
      if (m?.[1]?.trim()) return m[1].trim();
    }
  } catch {}
  return "";
}

async function networkUp(): Promise<boolean> {
  try {
    const res = await fetch("https://html.duckduckgo.com/html/?q=test", { signal: AbortSignal.timeout(8000) });
    return res.ok;
  } catch { return false; }
}

describe("FASE 4 — OpenCode runner REAL (sem sucesso falso)", () => {
  it("parseOpenCodeOutput classifica erro real de capacidade como FAILED (não sucesso)", () => {
    // JSON real capturado do OpenCode quando o Groq free estoura o limite
    const realError = '{"type":"error","timestamp":1,"sessionID":"ses_fba96f608ffe","error":{"name":"ContextOverflowError","data":{"message":"Request too large for model on tokens per minute (TPM): Limit 8000, Requested 47146"}}}';
    const parsed = parseOpenCodeOutput(realError);
    expect(parsed.sessionId).toBe("ses_fba96f608ffe");
    expect(parsed.text).toBe("");
    expect(parsed.fatalError).toMatch(/too large|TPM|47146/i);
  });

  it("parseOpenCodeOutput extrai texto de sucesso quando houver", () => {
    const ok = '{"type":"message","sessionID":"ses_x","message":{"content":[{"type":"text","text":"Tarefa concluída: 5 arquivos alterados"}]}}';
    const parsed = parseOpenCodeOutput(ok);
    expect(parsed.text).toContain("Tarefa concluída");
    expect(parsed.fatalError).toBeNull();
  });

  it("runner real: disponibilidade do OpenCode CLI", async () => {
    const runner = new OpenCodeSubagentRunner();
    const ok = await runner.isAvailable();
    expect(ok).toBe(true); // opencode está instalado no ambiente
  });

  it("runner real: execução OpenCode de verdade retorna resultado HONESTO (sucesso real ou FAILED com evidência)", async () => {
    const key = loadFirstGroqKey();
    if (key) process.env.GROQ_API_KEY = key;
    const runner = new OpenCodeSubagentRunner();
    const res = await runner.run({ agentId: "researcher", task: "Responda apenas com a palavra OK.", cwd: process.cwd(), timeoutMs: 40000 });
    // Nunca pode ser um sucesso vazio: ou há texto real, ou há erro real.
    if (res.status === "COMPLETED") {
      expect(res.output.trim().length).toBeGreaterThan(0);
    } else {
      expect(res.error && res.error.trim().length).toBeGreaterThan(0);
      // evidência de que foi o LLM/capacidade/timeout, não um crash do runner
      expect(res.unavailable).toBe(false);
    }
    // Classificação para o relatório
    const verdict = res.status === "COMPLETED" ? "PASS REAL" : "BLOCKED (capacidade LLM)";
    console.log(`[FASE4] OpenCode real → ${verdict} | erro=${(res.error ?? "").slice(0, 120)}`);
  }, 60000);
});

describe("FASE 4 — Paralelismo REAL (timestamps, isolamento, sem colisão)", () => {
  it("3 nós independentes web_search executam concorrentes com sobreposição real", async () => {
    if (!(await networkUp())) { console.log("[FASE4] sem rede — paralelismo real NOT VALIDATED"); return; }
    const { config } = setup();
    const run = createRun(config, { sessionKey: "f4-par", request: "paralelismo", goal: "provar paralelismo" });
    const plan: GraphPlan = {
      goal: "provar paralelismo",
      nodes: [
        { id: "a", title: "Busca A", type: "tool", toolId: "web_search", input: { query: "clínica de estética Sorocaba", maxResults: 3 }, requireCount: 1 },
        { id: "b", title: "Busca B", type: "tool", toolId: "web_search", input: { query: "restaurante japonês Sorocaba", maxResults: 3 }, requireCount: 1 },
        { id: "c", title: "Busca C", type: "tool", toolId: "web_search", input: { query: "academia Sorocaba", maxResults: 3 }, requireCount: 1 },
      ],
    };
    addNodes(config, run.id, plan);
    const ex = executorFor(config, new StubRunner(), 3, 1);
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");

    const nodes = listNodes(config, run.id);
    expect(nodes.length).toBe(3);
    // identificação correta + isolamento: cada nó tem id/output próprios
    const ids = new Set(nodes.map((n) => n.id));
    expect(ids.size).toBe(3);
    // timestamps reais
    for (const n of nodes) {
      expect(n.startedAt).toBeTruthy();
      expect(n.completedAt).toBeTruthy();
      expect(Date.parse(n.completedAt!)).toBeGreaterThanOrEqual(Date.parse(n.startedAt!));
      expect((n.output as any)).toBeTruthy();
    }
    // sobreposição real de intervalos → maxActive >= 2
    const iv = nodes.map((n) => [Date.parse(n.startedAt!), Date.parse(n.completedAt!)] as [number, number]);
    const events: Array<[number, number]> = [];
    for (const [s, e] of iv) { events.push([s, 1]); events.push([e, -1]); }
    events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let active = 0, maxActive = 0;
    for (const [, d] of events) { active += d; maxActive = Math.max(maxActive, active); }
    expect(maxActive).toBeGreaterThanOrEqual(2);
    console.log(`[FASE4] paralelismo real: maxActive=${maxActive} (nós=${nodes.length})`);
  }, 90000);
});

describe("FASE 4 — Recovery REAL (interrupção → retomada sem duplicação)", () => {
  it("nó COMPLETED não é re-executado após recovery; só pendentes continuam", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "f4-rec", request: "rec", goal: "recovery" });
    const plan: GraphPlan = {
      goal: "recovery",
      nodes: [
        { id: "a", title: "Listar objetivos", type: "tool", toolId: "goal_list" },
        { id: "b", title: "Buscar memória", type: "tool", toolId: "memory_search", dependencies: ["a"], input: { query: "teste" } },
      ],
    };
    addNodes(config, run.id, plan);
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({ registry, executor: new ToolExecutor(registry), subagentRunner: new StubRunner(), maxParallel: 1, maxRetries: 0 });

    // executa só o primeiro nó (a) e simula queda antes do segundo
    const nodes0 = listNodes(config, run.id);
    const a = nodes0.find((n) => n.title === "Listar objetivos")!;
    const resA = await (new ToolExecutor(registry)).execute({ toolId: "goal_list", input: {}, ctx: { config, sessionId: "f4-rec" }, preApproved: true });
    updateNode(config, a.id, { status: "COMPLETED", output: resA.output as Record<string, unknown>, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() });
    const b = nodes0.find((n) => n.title === "Buscar memória")!;
    updateNode(config, b.id, { status: "RUNNING", startedAt: new Date(Date.now() - 3600000).toISOString() });
    markStaleForTest(config, run.id, new Date(Date.now() - 3600000).toISOString());

    // recovery bloqueia o que estava em andamento
    const recovered = recoverStaleRuns(config, { staleAfterMs: 5 * 60 * 1000 });
    expect(recovered.some((r) => r.runId === run.id)).toBe(true);
    expect(getRun(config, run.id)?.status).toBe("BLOCKED");

    // retomada real: só pendentes/interrompidos voltam; COMPLETED preservado
    const before = listNodes(config, run.id).find((n) => n.title === "Listar objetivos")!.completedAt;
    const resumable = prepareResume(config, run.id);
    expect(resumable.keptCompleted).toBeGreaterThanOrEqual(1);
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    const after = listNodes(config, run.id);
    expect(after.every((n) => n.status === "COMPLETED")).toBe(true);
    // COMPLETED não foi duplicado: mesmo completedAt (não re-executado)
    const aAfter = after.find((n) => n.title === "Listar objetivos")!;
    expect(aAfter.completedAt).toBe(before);
  });
});

describe("FASE 4 — Rework REAL (FAILED → evidência → REWORK → RETRY → SUCCESS)", () => {
  it("avaliador FAILED com evidência de quantidade insuficiente (não converte em sucesso)", async () => {
    if (!(await networkUp())) { console.log("[FASE4] sem rede — rework FAILED NOT VALIDATED"); return; }
    const { config } = setup();
    const run = createRun(config, { sessionKey: "f4-rw", request: "rw", goal: "rework fail", maxRetries: 1 });
    addNodes(config, run.id, {
      goal: "rework fail",
      nodes: [{ id: "a", title: "Busca impossível", type: "tool", toolId: "web_search", input: { query: "zzzzkqxp inexistente", maxResults: 5 }, requireCount: 50 }],
    });
    const ex = executorFor(config, new StubRunner(), 1, 1);
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("FAILED");
    const node = listNodes(config, run.id)[0]!;
    expect(node.status).toBe("FAILED");
    expect(node.evidence.some((e) => e.kind === "count")).toBe(true);
    expect(node.retryCount).toBeGreaterThanOrEqual(1); // tentou rework antes de falhar de vez
  }, 60000);

  it("REWORK → RETRY → SUCCESS quando o executor recupera (mecânica real do loop)", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "f4-rw2", request: "rw2", goal: "rework success", maxRetries: 3 });
    addNodes(config, run.id, { goal: "rework success", nodes: [{ id: "a", title: "Passo instável", type: "implementation", assignedAgent: "developer" }] });
    const stub = new StubRunner();
    stub.failTimes = 2; // falha 2x, depois succeede
    const ex = executorFor(config, stub, 1, 3);
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    const node = listNodes(config, run.id)[0]!;
    expect(node.status).toBe("COMPLETED");
    expect(node.retryCount).toBeGreaterThanOrEqual(2);
    expect(stub.calls.length).toBe(3); // 2 falhas + 1 sucesso
    // evidência final presente
    expect(node.evidence.length).toBeGreaterThan(0);
  });
});

describe("FASE 4 — Long-horizon REAL (DAG multi-etapa até COMPLETE + Obsidian)", () => {
  it("grafo research→context→implement(goal)→verify com tools reais conclui e persiste conhecimento", async () => {
    const { config } = setup();
    const run = createRun(config, { sessionKey: "f4-lh", request: "analisar e melhorar prospecção", goal: "long-horizon prospecção" });
    // Ferramentas REAIS locais (sem depender de rede externa, que sofre rate-limit):
    // brain_search/memory_search pesquisam o cérebro; goal_create implementa o
    // objetivo; goal_list verifica. DAG: research/context paralelos → register → verify.
    const nodes: GraphPlan["nodes"] = [
      { id: "research", title: "Pesquisar no cérebro", type: "tool", toolId: "brain_search", input: { query: "prospecção", limit: 3 } },
      { id: "context", title: "Consultar memórias", type: "tool", toolId: "memory_search", input: { query: "prospecção", limit: 3 }, dependencies: [] },
      { id: "register", title: "Implementar objetivo", type: "tool", toolId: "goal_create", input: { name: "Melhorar prospecção (long-horizon)", type: "BUSINESS", description: "Objetivo criado pelo graph long-horizon" }, dependencies: ["research", "context"] },
      { id: "verify", title: "Verificar objetivos", type: "tool", toolId: "goal_list", input: {}, dependencies: ["register"] },
    ];
    addNodes(config, run.id, { goal: "long-horizon prospecção", nodes });
    const ex = executorFor(config, new StubRunner(), 3, 1);
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");
    const all = listNodes(config, run.id);
    expect(all.length).toBe(4);
    expect(all.every((n) => n.status === "COMPLETED")).toBe(true);

    // dependências respeitadas: verify só inicia depois de register concluir
    const register = all.find((n) => n.title === "Implementar objetivo")!;
    const verify = all.find((n) => n.title === "Verificar objetivos")!;
    expect(Date.parse(verify.startedAt!)).toBeGreaterThanOrEqual(Date.parse(register.completedAt!));
    // research e context (independentes) rodam antes de register
    expect(Date.parse(register.startedAt!)).toBeGreaterThanOrEqual(Date.parse(all.find((n) => n.id.endsWith(".n1"))!.completedAt!));

    // evidência real no nó verify (goal_list retorna o objetivo criado)
    const verifyOut = JSON.stringify(verify.output ?? {});
    expect(verifyOut).toMatch(/Melhorar prospecção|long-horizon/i);

    // Graph → Obsidian: conhecimento útil persistido (sem dump técnico)
    const written = persistGraphOutcome(config, run.id);
    expect(written.written).toBe(true);
    expect(written.path).toBeTruthy();
  }, 60000);
});
