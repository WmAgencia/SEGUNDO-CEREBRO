/**
 * Graph Executor — runs a persisted DAG with:
 *   - Scheduler (readiness + parallelism, MAX_PARALLEL_NODES)
 *   - Tool Executor (real registry tools, approval gate reused)
 *   - Subagent Runner (real OpenCode subagents; unavailable → BLOCKED)
 *   - Evaluator (evidence-based verdicts)
 *   - Rework loop (max_retries / max_iterations / timeout) with safe stop
 *   - Observability (every transition recorded as graph_node events)
 *
 * Deterministic by design: all decisions come from state + evidence, never
 * from "the LLM said it's done".
 */

import type { BrainConfig } from "../config/loader.ts";
import type { ToolRegistry } from "../agent/tools/registry.ts";
import type { ToolExecutor } from "../agent/tools/executor.ts";
import {
  getRun,
  listNodes,
  updateNode,
  updateRunStatus,
  recordNodeEvent,
  recordRunEvent,
  touchRun,
} from "./graph-store.ts";
import { schedule, assignParallelGroups } from "./scheduler.ts";
import { evaluateNode } from "./evaluator.ts";
import type { SubagentRunner } from "./subagents/opencode-runner.ts";
import { isReadOnlySubagent } from "./subagents/agents.ts";
import { orchestrationLimits } from "./limits.ts";

export interface GraphExecutorOptions {
  registry: ToolRegistry;
  executor: ToolExecutor;
  subagentRunner: SubagentRunner;
  requestApproval?: (toolId: string, input: Record<string, unknown>) => Promise<boolean>;
  maxParallel?: number;
  maxRetries?: number;
  maxIterations?: number;
}

export interface NodeOutcome {
  nodeId: string;
  status: string;
  retryCount: number;
  iteration: number;
  error?: string | null;
}

export interface RunOutcome {
  runId: string;
  status: string;
  completed: number;
  failed: number;
  blocked: number;
  reworked: number;
  outcomes: NodeOutcome[];
}

export class GraphExecutor {
  private registry: ToolRegistry;
  private executor: ToolExecutor;
  private subagentRunner: SubagentRunner;
  private requestApproval?: (toolId: string, input: Record<string, unknown>) => Promise<boolean>;
  private limits: ReturnType<typeof orchestrationLimits>;

  constructor(options: GraphExecutorOptions) {
    this.registry = options.registry;
    this.executor = options.executor;
    this.subagentRunner = options.subagentRunner;
    this.requestApproval = options.requestApproval;
    this.limits = orchestrationLimits();
    if (options.maxParallel) this.limits = { ...this.limits, maxParallel: options.maxParallel };
    if (options.maxRetries) this.limits = { ...this.limits, maxRetries: options.maxRetries };
    if (options.maxIterations) this.limits = { ...this.limits, maxIterations: options.maxIterations };
  }

  async execute(config: BrainConfig, runId: string): Promise<RunOutcome> {
    const run = getRun(config, runId);
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.status === "COMPLETED" || run.status === "FAILED" || run.status === "BLOCKED" || run.status === "CANCELLED") {
      return this.instantSummary(config, runId);
    }

    updateRunStatus(config, runId, "RUNNING");
    recordRunEvent(config, runId, "GRAPH_STARTED", {
      sessionId: run.sessionKey,
      extra: { planner: run.planner, request: run.request.slice(0, 200) },
    });
    for (const node of listNodes(config, runId)) {
      if (node.status === "PENDING" || node.status === "READY") {
        recordRunEvent(config, runId, "NODE_READY", { nodeId: node.id, sessionId: run.sessionKey, agentId: node.assignedAgent });
      }
    }
    let wave = 0;
    const summary: RunOutcome = {
      runId,
      status: "RUNNING",
      completed: 0,
      failed: 0,
      blocked: 0,
      reworked: 0,
      outcomes: [],
    };

    for (let iteration = 0; iteration < this.limits.maxIterations * 20; iteration++) {
      const nodes = listNodes(config, runId);
      if (nodes.length === 0) {
        updateRunStatus(config, runId, "FAILED", { error: "run sem nodes" });
        return this.instantSummary(config, runId);
      }

      const sched = schedule(nodes, this.limits.maxParallel);

      if (sched.blocked.length > 0) {
        let hasFailedDep = false;
        for (const node of sched.blocked) {
          if (node.status !== "PENDING" && node.status !== "READY" && node.status !== "REWORK") continue;
          const failedDep = listNodes(config, runId).some((n) => node.dependencies.includes(n.id) && n.status === "FAILED");
          if (failedDep) hasFailedDep = true;
          updateNode(config, node.id, { status: "BLOCKED", error: failedDep ? "dependência falhou" : "dependência bloqueada" });
          recordNodeEvent(config, runId, node.id, "blocked", { because: failedDep ? "failed_dependency" : "blocked_dependency" });
          recordRunEvent(config, runId, "NODE_BLOCKED", { nodeId: node.id, sessionId: node.sessionId ?? undefined, agentId: node.assignedAgent, extra: { because: failedDep ? "failed_dependency" : "blocked_dependency" } });
          summary.blocked += 1;
          summary.outcomes.push({ nodeId: node.id, status: "BLOCKED", retryCount: node.retryCount, iteration: node.iteration });
        }
        const finalStatus = hasFailedDep ? "FAILED" : "BLOCKED";
        updateRunStatus(config, runId, finalStatus, { summary: collectProgress(config, runId) });
        recordRunEvent(config, runId, finalStatus === "FAILED" ? "GRAPH_FAILED" : "GRAPH_BLOCKED", { sessionId: run.sessionKey, extra: { reason: "dependency_block" } });
        return this.finalize(config, runId, summary, finalStatus);
      }

      if (sched.ready.length === 0) {
        if (sched.complete) {
          updateRunStatus(config, runId, "COMPLETED", { summary: collectProgress(config, runId) });
          recordRunEvent(config, runId, "GRAPH_COMPLETED", { sessionId: run.sessionKey, extra: { completed: summary.completed, reworked: summary.reworked } });
          return this.finalize(config, runId, summary, "COMPLETED");
        }
        if (sched.stalled) {
          updateRunStatus(config, runId, "BLOCKED", { error: "run estagnada: nó em RUNNING/REWORK sem progresso" });
          recordRunEvent(config, runId, "GRAPH_BLOCKED", { sessionId: run.sessionKey, extra: { reason: "stalled" } });
          return this.finalize(config, runId, summary, "BLOCKED");
        }
        // no ready + no complete + no stalled + no blocked → everything final but partially failed
        const hasBlocked = nodes.some((n) => n.status === "BLOCKED");
        const hasFailed = nodes.some((n) => n.status === "FAILED");
        const finalStatus = hasBlocked && !hasFailed ? "BLOCKED" : "FAILED";
        updateRunStatus(config, runId, finalStatus, { summary: collectProgress(config, runId) });
        recordRunEvent(config, runId, finalStatus === "FAILED" ? "GRAPH_FAILED" : "GRAPH_BLOCKED", { sessionId: run.sessionKey, extra: { reason: "no_progress" } });
        return this.finalize(config, runId, summary, finalStatus);
      }

      wave += 1;
      const groups = assignParallelGroups(sched.ready, wave)
      const allNodes = listNodes(config, runId)
      for (const node of allNodes) {
        if (groups.has(node.id)) {
          updateNode(config, node.id, { parallelGroup: groups.get(node.id) ?? null });
        }
      }

      const results = await Promise.all(
        sched.ready.map(async (node) => {
          const outcome = await this.runNode(config, runId, node.id);
          summary.outcomes.push(outcome);
          return outcome;
        }),
      );
      for (const o of results) {
        if (o.status === "COMPLETED") summary.completed += 1;
        else if (o.status === "FAILED") summary.failed += 1;
        else if (o.status === "BLOCKED") summary.blocked += 1;
        else if (o.status === "REWORK") summary.reworked += 1;
      }
      touchRun(config, runId);
    }

    updateRunStatus(config, runId, "BLOCKED", { error: "atingiu o teto de iterações da execução (segurança)" });
    return this.finalize(config, runId, summary, "BLOCKED");
  }

  private async runNode(config: BrainConfig, runId: string, nodeId: string): Promise<NodeOutcome> {
    const node = listNodes(config, runId).find((n) => n.id === nodeId);
    if (!node) return { nodeId, status: "FAILED", retryCount: 0, iteration: 0, error: "node não encontrado" };

    updateNode(config, node.id, { status: "RUNNING", startedAt: node.startedAt ?? new Date().toISOString() });
    recordNodeEvent(config, runId, node.id, "started", { retry: node.retryCount });
    recordRunEvent(config, runId, "NODE_STARTED", { nodeId: node.id, sessionId: node.sessionId ?? undefined, agentId: node.assignedAgent, extra: { retry: node.retryCount } });

    let outcome: { success: boolean; output?: Record<string, unknown> | null; error?: string | null; sessionId?: string | null; blocked?: boolean } | null = null;

    // ── Node input unpack ──
    const input = node.input ?? {};
    const isToolNode = node.type === "tool" || (node.assignedAgent === "tool" && !node.evaluate?.toolId) || Boolean(node.evaluate?.toolId);

    if (isToolNode) {
      const toolId = String(node.evaluate?.toolId ?? input.toolId ?? "");
      if (!this.registry.get(toolId) || !this.registry.get(toolId)?.available) {
        outcome = { success: false, error: `ferramenta indisponível/desconhecida: ${toolId}`, blocked: true };
      } else {
        // approval for risky tools ONLY when an explicit approval channel exists
        // (graph_execute already acts as the run-level approval gate when none provided)
        const tool = this.registry.get(toolId)!;
        if (this.requestApproval && tool.requiresApproval) {
          const approved = await this.requestApproval(toolId, input);
          if (!approved) {
            outcome = { success: false, error: `aprovacao necessária para ${toolId} não concedida`, blocked: true };
          }
        }
        if (!outcome) {
          const res = await this.executor.execute({ toolId, input, ctx: { config, sessionId: node.sessionId ?? undefined, userContext: this.requestApproval ? { requestApproval: this.requestApproval } : undefined }, sessionId: node.sessionId ?? undefined, preApproved: true });
          outcome = { success: res.success, output: (res.output as Record<string, unknown>) ?? { raw: String(res.output ?? "") }, error: res.error, sessionId: null };
        }
      }
    } else {
      // ── subagent node ──
      const agentId = node.assignedAgent ?? "researcher";
      const readOnly = isReadOnlySubagent(agentId);
      if (!readOnly && this.requestApproval) {
        const approved = await this.requestApproval(`subagent:${agentId}`, { task: node.title, runId });
        if (!approved) {
          outcome = { success: false, error: `aprovacao para subagent ${agentId} não concedida`, blocked: true };
        }
      }
      if (!outcome) {
        const depsContext = collectDependencyResults(config, runId, node);
        const taskText = buildTaskText(node, input, depsContext);
        const res = await this.subagentRunner.run({
          agentId,
          task: taskText,
          cwd: resolveWorkspace(config),
          model: typeof input.model === "string" ? input.model : undefined,
          timeoutMs: this.limits.opencodeTimeoutMs,
        });
        outcome = {
          success: res.ok && res.status === "COMPLETED",
          output: { agentId, sessionId: res.sessionId, output: res.output.slice(0, 6000), filesChanged: res.filesChanged, testsPassed: res.testsPassed },
          error: res.error,
          blocked: res.unavailable,
          sessionId: res.sessionId,
        };
      }
    }

    if (!outcome) outcome = { success: false, error: "sem resultado" };

    if (outcome.blocked) {
      updateNode(config, node.id, { status: "BLOCKED", error: outcome.error ?? "bloqueado", output: outcome.output ?? null, completedAt: new Date().toISOString(), sessionId: outcome.sessionId ?? node.sessionId });
      recordNodeEvent(config, runId, node.id, "blocked", { error: outcome.error });
      return { nodeId, status: "BLOCKED", retryCount: node.retryCount, iteration: node.iteration, error: outcome.error };
    }

    const updated = updateNode(config, node.id, {
      status: outcome.success ? "COMPLETED" : "FAILED",
      output: outcome.output ?? { raw: String(outcome.output ?? (outcome.error ?? "sem conteúdo")) },
      error: outcome.success ? null : outcome.error ?? "falha sem detalhe",
      completedAt: new Date().toISOString(),
      sessionId: outcome.sessionId ?? node.sessionId,
      evidence: [],
    });

    if (!updated) return { nodeId, status: "FAILED", retryCount: node.retryCount, iteration: node.iteration, error: "update falhou" };

    // evaluator
    const verdict = evaluateNode(updated);
    recordRunEvent(config, runId, "GRAPH_EVALUATED", { nodeId: node.id, sessionId: updated.sessionId ?? undefined, agentId: updated.assignedAgent, extra: { pass: verdict.pass, reason: verdict.reason.slice(0, 200) } });
    if (!verdict.pass) {
      if (updated.retryCount < this.limits.maxRetries) {
        const next = updateNode(config, node.id, { status: "REWORK", retryCount: updated.retryCount + 1, evidence: verdict.evidence, error: outcome.error ?? verdict.reason });
        recordNodeEvent(config, runId, node.id, "rework", { reason: verdict.reason, retry: next?.retryCount });
        recordRunEvent(config, runId, updated.retryCount === 0 ? "NODE_REWORK" : "NODE_RETRY", { nodeId: node.id, sessionId: updated.sessionId ?? undefined, agentId: updated.assignedAgent, extra: { reason: verdict.reason.slice(0, 200), retry: next?.retryCount } });
        return { nodeId, status: "REWORK", retryCount: next?.retryCount ?? 1, iteration: node.iteration, error: verdict.reason };
      }
      const final = updateNode(config, node.id, { status: "FAILED", evidence: verdict.evidence, error: outcome.error ?? verdict.reason });
      recordNodeEvent(config, runId, node.id, "failed", { reason: verdict.reason });
      recordRunEvent(config, runId, "NODE_FAILED", { nodeId: node.id, sessionId: updated.sessionId ?? undefined, agentId: updated.assignedAgent, extra: { reason: verdict.reason.slice(0, 200), retry: final?.retryCount } });
      return { nodeId, status: "FAILED", retryCount: final?.retryCount ?? node.retryCount, iteration: node.iteration, error: verdict.reason };
    }

    updateNode(config, node.id, { evidence: verdict.evidence });
    recordNodeEvent(config, runId, node.id, "completed", { evidence: verdict.evidence.length });
    recordRunEvent(config, runId, "NODE_COMPLETED", { nodeId: node.id, sessionId: updated.sessionId ?? undefined, agentId: updated.assignedAgent, extra: { evidence: verdict.evidence.length, retry: updated.retryCount } });
    return { nodeId, status: "COMPLETED", retryCount: node.retryCount, iteration: node.iteration, error: null };
  }

  private instantSummary(config: BrainConfig, runId: string): RunOutcome {
    const run = getRun(config, runId);
    const nodes = listNodes(config, runId);
    return {
      runId,
      status: run?.status ?? "UNKNOWN",
      completed: nodes.filter((n) => n.status === "COMPLETED").length,
      failed: nodes.filter((n) => n.status === "FAILED").length,
      blocked: nodes.filter((n) => n.status === "BLOCKED").length,
      reworked: nodes.reduce((acc, n) => acc + n.retryCount, 0),
      outcomes: nodes.map((n) => ({ nodeId: n.id, status: n.status, retryCount: n.retryCount, iteration: n.iteration, error: n.error })),
    };
  }

  private finalize(config: BrainConfig, runId: string, summary: RunOutcome, status: string): RunOutcome {
    return { ...this.instantSummary(config, runId), status: getRun(config, runId)?.status ?? status };
  }
}

function buildTaskText(node: { title: string; description: string; input: Record<string, unknown> }, input: Record<string, unknown>, depsContext = ""): string {
  const parts = [
    `Tarefa do grafo: ${node.title}`,
    node.description,
    input.task ? String(input.task) : undefined,
    input.request ? `Pedido do usuário: ${String(input.request)}` : undefined,
    depsContext ? `Resultado dos nós anteriores:\n${depsContext}` : undefined,
  ].filter(Boolean);
  return parts.join("\n\n").slice(0, 6000);
}

/**
 * FASE 4 (seção 8): contexto sob demanda — reúne apenas o resultado dos nós de
 * dependência já concluídos (não o vault inteiro), para o agente trabalhar com
 * base real no que o grafo já produziu.
 */
function collectDependencyResults(config: BrainConfig, runId: string, node: { id: string; dependencies: string[] }): string {
  if (!node.dependencies?.length) return "";
  const all = listNodes(config, runId);
  const deps = all.filter((n) => node.dependencies.includes(n.id) && n.status === "COMPLETED");
  if (!deps.length) return "";
  return deps
    .map((d) => {
      const out = d.output ? JSON.stringify(d.output) : "";
      return `- [${d.title}] ${out.slice(0, 800)}`;
    })
    .join("\n")
    .slice(0, 2400);
}

function resolveWorkspace(config: BrainConfig): string {
  // subagents run in the repo root (second-brain) where opencode resolves the project
  return process.cwd();
}

function collectProgress(config: BrainConfig, runId: string): Record<string, unknown> {
  const nodes = listNodes(config, runId);
  return {
    completed: nodes.filter((n) => n.status === "COMPLETED").map((n) => n.title),
    blocked: nodes.filter((n) => n.status === "BLOCKED").map((n) => n.title),
    failed: nodes.filter((n) => n.status === "FAILED").map((n) => n.title),
    status: "see run",
  };
}