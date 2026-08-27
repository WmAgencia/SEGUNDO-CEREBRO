/**
 * Graph tools — expose the Orchestration (planner + store + executor +
 * evaluator + rework + recovery) to the Single Agent as native tools.
 *
 * The Single Agent decides WHEN to use a graph; these tools are the hands.
 *
 * - graph_plan:    builds a DAG plan for a multi-step request (no execution)
 * - graph_execute: EXECUTES a run (tools + subagents + evaluator + rework).
 *                  HIGH risk → approval gate (never silent autonomous work)
 * - graph_status:  progress of a run ("o que está sendo feito / por quê")
 * - graph_list:    runs of the current session
 * - graph_recover: recovery of stale runs at startup / on demand
 */

import type { ToolDefinition, ToolExecutionContext } from "./registry.ts";
import { classifyIntent, planForRequest } from "../../orchestration/planner.ts";
import {
  createRun, addNodes, getRun, listRuns, listNodes, recordRunEvent,
} from "../../orchestration/graph-store.ts";
import { GraphExecutor } from "../../orchestration/executor.ts";
import { recoverStaleRuns, prepareResume } from "../../orchestration/recovery.ts";
import { OpenCodeSubagentRunner } from "../../orchestration/subagents/opencode-runner.ts";
import { persistGraphOutcome } from "../../organization/graph-obsidian.ts";

function nodeSummary(nodes: ReturnType<typeof listNodes>, runStatus: string): string {
  const per = nodes
    .map((n) => `${n.title} [${n.status}]${n.parallelGroup ? ` (${n.parallelGroup})` : ""}${n.error ? ` — ${n.error.slice(0, 140)}` : ""}`)
    .join("\n");
  return `Run: ${runStatus}\n${per}`;
}

function planToReadable(runId: string, nodes: ReturnType<typeof listNodes>): string {
  return `Plano ${runId} (${nodes.length} nós).\n${nodes.map((n) => `- ${n.title} → ${n.assignedAgent ?? "tool"}`).join("\n")}`;
}

export const graphPlanTool: ToolDefinition = {
  id: "graph_plan",
  name: "Planejar trabalho multi-etapas (Graph)",
  description:
    "Cria um plano DAG para trabalhos multi-etapas (ex.: 'colocar X funcionando', 'criar sistema de prospecção'). Retorna runId e nós; não executa nada.",
  category: "orchestration",
  permissions: ["READ"],
  riskLevel: "MEDIUM",
  requiresApproval: false,
  timeoutMs: 15_000,
  provenance: "local:orchestration",
  inputSchema: {
    type: "object",
    properties: {
      request: { type: "string", description: "pedido do usuário" },
      projectId: { type: "string", description: "id do projeto, se conhecido (ex.: project.clipcom)" },
    },
    required: ["request"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const request: string = String(input.request ?? "").trim();
    if (!request) return { success: false, output: null, error: "request required" };
    if (classifyIntent(request) !== "GRAPH") {
      return { success: true, output: { graph: false, hint: "solicitação simples — sem graph necessário" } };
    }
    const plan = planForRequest(request, { projectId: input.projectId ? String(input.projectId) : undefined });
    if (!plan) return { success: true, output: { graph: false, hint: "plano não gerado" } };

    // Contexto real do Second Brain injetado nos nós (FASE 3.6, seção 10):
    // cada node recebe um resumo do cérebro para trabalhar com base real.
    let brainNote = "";
    try {
      const { compileContext } = await import("../../agent/context-compiler.ts");
      const cctx = await compileContext({ subject: request }, ctx.config);
      brainNote = [
        cctx.summary ? `Contexto:\n${cctx.summary.slice(0, 1200)}` : "",
        cctx.procedures?.length ? `Procedimentos: ${cctx.procedures.slice(0, 3).join("; ")}` : "",
        cctx.decisions?.length ? `Decisões: ${cctx.decisions.slice(0, 3).join("; ")}` : "",
        cctx.documents?.length ? `Notas relevantes: ${cctx.documents.slice(0, 3).map((d) => d.title).join("; ")}` : "",
      ].filter(Boolean).join("\n");
    } catch {
      brainNote = "";
    }

    const planWithContext = {
      ...plan,
      goal: `${plan.goal}${input.projectId ? ` (${input.projectId})` : ""}`,
      nodes: plan.nodes.map((n) => ({
        ...n,
        input: {
          ...n.input,
          ...(brainNote ? { brainContext: brainNote } : {}),
        },
      })),
    };
    const run = createRun(ctx.config, {
      sessionKey: ctx.sessionId ?? "graph",
      request,
      goal: planWithContext.goal,
      planner: "rule",
      projectId: planWithContext.projectId,
    });
    const nodes = addNodes(ctx.config, run.id, planWithContext);
    recordRunEvent(ctx.config, run.id, "GRAPH_CREATED", { sessionId: ctx.sessionId, extra: { planner: "rule", totalNodes: nodes.length } });
    return {
      success: true,
      output: { graph: true, runId: run.id, totalNodes: nodes.length, readable: planToReadable(run.id, nodes) },
    };
  },
};

export const graphExecuteTool: ToolDefinition = {
  id: "graph_execute",
  name: "Executar Graph",
  description:
    "Executa um plano DAG salvo (graph_plan): roda tools e subagentes (researcher/developer/qa...), avalia cada resultado com evidência e aplica rework. Ação autônoma de risco: requer aprovação.",
  category: "orchestration",
  permissions: ["EXECUTE", "WRITE"],
  riskLevel: "HIGH",
  requiresApproval: true,
  timeoutMs: 600_000,
  provenance: "local:orchestration",
  inputSchema: {
    type: "object",
    properties: { runId: { type: "string", description: "id do run criado por graph_plan" } },
    required: ["runId"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const runId: string = String(input.runId ?? "").trim();
    if (!runId) return { success: false, output: null, error: "runId required" };
    const run = getRun(ctx.config, runId);
    if (!run) return { success: false, output: null, error: `run not found: ${runId}` };

    // FASE 3.6: retomada real de run interrompido (recovery → resume) —
    // nunca duplica ação já concluída; nós COMPLETED permanecem.
    let resumed: { resumedNodes: number; keptCompleted: number; blockedNodes: number } | null = null;
    if (input.resume === true || input.resume === "true" || (run.status === "BLOCKED" && run.result?.recovery)) {
      resumed = prepareResume(ctx.config, runId);
    }

    const { createDefaultRegistry } = await import("./index.ts");
    const { ToolExecutor } = await import("./executor.ts");
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({
      registry,
      executor: new ToolExecutor(registry),
      subagentRunner: new OpenCodeSubagentRunner(),
      requestApproval: ctx.userContext?.requestApproval
        ? (toolId: string, toolInput: Record<string, unknown>) => (ctx.userContext?.requestApproval?.(toolId, toolInput) ?? Promise.resolve(false))
        : undefined,
    });
    const outcome = await ex.execute(ctx.config, runId);
    const persisted = persistGraphOutcome(ctx.config, runId);
    return {
      success: outcome.status === "COMPLETED",
      output: {
        runId,
        status: outcome.status,
        completed: outcome.completed,
        failed: outcome.failed,
        blocked: outcome.blocked,
        reworked: outcome.reworked,
        resumed: resumed ? { resumedNodes: resumed.resumedNodes, keptCompleted: resumed.keptCompleted } : undefined,
        vault: persisted.action === "created" || persisted.action === "updated"
          ? { note: persisted.path, action: persisted.action }
          : undefined,
        readable: `Run ${runId}: ${outcome.status} (${outcome.completed} concluídos, ${outcome.failed} falhas, ${outcome.blocked} bloqueados, ${outcome.reworked} reworks).${resumed ? ` Retomado: ${resumed.resumedNodes} nós re-executados, ${resumed.keptCompleted} já concluídos preservados.` : ""}${persisted.written ? ` Resultado registrado no vault: ${persisted.path} (${persisted.action}).` : ""}`,
      },
    };
  },
};

export const graphStatusTool: ToolDefinition = {
  id: "graph_status",
  name: "Status do Graph",
  description: "Retorna progresso de um run: status, nós, bloqueios e erros.",
  category: "orchestration",
  permissions: ["READ"],
  riskLevel: "LOW",
  requiresApproval: false,
  timeoutMs: 10_000,
  provenance: "local:orchestration",
  inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const run = getRun(ctx.config, String(input.runId ?? ""));
    if (!run) return { success: false, output: null, error: "run not found" };
    const nodes = listNodes(ctx.config, run.id);
    return { success: true, output: { runId: run.id, status: run.status, readable: nodeSummary(nodes, run.status) } };
  },
};

export const graphListTool: ToolDefinition = {
  id: "graph_list",
  name: "Listar Graphs",
  description: "Lista os runs da sessão atual.",
  category: "orchestration",
  permissions: ["READ"],
  riskLevel: "LOW",
  requiresApproval: false,
  timeoutMs: 10_000,
  provenance: "local:orchestration",
  inputSchema: { type: "object", properties: { limit: { type: "number" } }, required: [] },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (_input, ctx) => {
    const runs = listRuns(ctx.config, ctx.sessionId ?? undefined, 20);
    return {
      success: true,
      output: {
        readable: runs.length
          ? runs.map((r) => `- ${r.id} [${r.status}] "${r.goal.slice(0, 80)}"`).join("\n")
          : "nenhum run nesta sessão",
      },
    };
  },
};

export const graphRecoverTool: ToolDefinition = {
  id: "graph_recover",
  name: "Recuperar runs presos",
  description: "Detecta e bloqueia runs stale (processo interrompido) — safe-by-default, nunca retoma sozinho.",
  category: "orchestration",
  permissions: ["WRITE"],
  riskLevel: "MEDIUM",
  requiresApproval: false,
  timeoutMs: 20_000,
  provenance: "local:orchestration",
  inputSchema: { type: "object", properties: {}, required: [] },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (_input, ctx) => {
    const recovered = recoverStaleRuns(ctx.config);
    return {
      success: true,
      output: {
        recovered: recovered.length,
        readable: recovered.map((r) => `- ${r.runId}: ${r.reason}`).join("\n") || "nenhum run stale",
      },
    };
  },
};