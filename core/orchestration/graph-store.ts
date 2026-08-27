/**
 * Graph Store — persistence of runs and nodes (SQLite, node:sqlite).
 *
 * The Obsidian Vault stays the long-term memory; these tables are the
 * OPERATIONAL database for orchestration (as required: banco para runs,
 * graph_nodes, session, tool_calls, events; Obsidian para conhecimento).
 */

import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { openDatabase } from "../../storage/connection.ts";
import {
  GraphNode,
  GraphRun,
  GraphPlan,
  GraphPlanInput,
  GraphNodeStatus,
  GraphRunStatus,
} from "./types.ts";
import { validateGraph } from "./graph-validator.ts";

export function makeRunId(): string {
  return `run.${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 6)}`;
}

export function makeNodeId(runId: string, ordinal: number): string {
  return `${runId}.n${ordinal}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ── Runs ────────────────────────────────────────────────────────────────

export interface CreateRunOptions {
  id?: string;
  sessionKey: string;
  request: string;
  goal: string;
  planner?: "rule" | "llm";
  projectId?: string | null;
  maxParallel?: number;
  maxRetries?: number;
  maxIterations?: number;
}

export function createRun(config: BrainConfig, opts: CreateRunOptions): GraphRun {
  const id = opts.id ?? makeRunId();
  const db = openDatabase(config.dbPath);
  try {
    db.prepare(
      `INSERT INTO graph_runs (id, session_key, request, goal, status, planner, project_id,
        max_parallel, max_retries, max_iterations, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'PLANNED', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      opts.sessionKey,
      opts.request.slice(0, 4000),
      opts.goal.slice(0, 2000),
      opts.planner ?? "rule",
      opts.projectId ?? null,
      opts.maxParallel ?? 2,
      opts.maxRetries ?? 2,
      opts.maxIterations ?? 3,
      nowIso(),
      nowIso(),
    );
    return getRun(config, id) as GraphRun;
  } finally {
    db.close();
  }
}

export function getRun(config: BrainConfig, id: string): GraphRun | null {
  const db = openDatabase(config.dbPath);
  try {
    const row = db.prepare("SELECT * FROM graph_runs WHERE id = ?").get(id);
    return row ? mapRun(row) : null;
  } finally {
    db.close();
  }
}

export function listRuns(config: BrainConfig, sessionKey?: string, limit = 20): GraphRun[] {
  const db = openDatabase(config.dbPath);
  try {
    const rows = sessionKey
      ? db.prepare("SELECT * FROM graph_runs WHERE session_key = ? ORDER BY created_at DESC LIMIT ?").all(sessionKey, limit)
      : db.prepare("SELECT * FROM graph_runs ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as unknown[]).map(mapRun);
  } finally {
    db.close();
  }
}

export function updateRunStatus(config: BrainConfig, id: string, status: GraphRunStatus, result: Record<string, unknown> = {}): void {
  const db = openDatabase(config.dbPath);
  const completedAt = status === "COMPLETED" || status === "FAILED" || status === "BLOCKED" || status === "CANCELLED" ? nowIso() : null;
  try {
    db.prepare(
      "UPDATE graph_runs SET status = ?, result_json = ?, completed_at = ?, updated_at = ? WHERE id = ?",
    ).run(status, JSON.stringify(result), completedAt, nowIso(), id);
  } finally {
    db.close();
  }
}

// ── Node CRUD ──────────────────────────────────────────────────────────

function ordinalOf(nodes: GraphPlanInput[], ref: string): number {
  const direct = nodes.findIndex((n) => n.id === ref);
  if (direct !== -1) return direct + 1;
  const byTitle = nodes.findIndex((n) => n.title === ref);
  return byTitle === -1 ? 1 : byTitle + 1;
}

export function addNodes(config: BrainConfig, runId: string, plan: GraphPlan): GraphNode[] {
  const db = openDatabase(config.dbPath);
  try {
    const existing = (db.prepare("SELECT COUNT(*) AS c FROM graph_nodes WHERE run_id = ?").get(runId) as { c: number }).c;
    if (existing > 0) throw new Error(`run ${runId} already has nodes (${existing})`);
    const insert = db.prepare(
      `INSERT INTO graph_nodes (id, run_id, parent_id, ordinal, type, title, description,
        status, dependencies_json, assigned_agent, session_id, input_json, output_json, error,
        retry_count, iteration, parallel_group, evidence_json, evaluate_json, started_at,
        completed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, NULL, ?, '{}', NULL, 0, 0, NULL, '[]', ?, NULL, NULL, ?)`,
    );
    for (let i = 0; i < plan.nodes.length; i++) {
      const n = plan.nodes[i]!;
      const ordinal = i + 1;
      const id = makeNodeId(runId, ordinal);
      const deps = (n.dependencies ?? []).map((d) => makeNodeId(runId, ordinalOf(plan.nodes, d)));
      const parentId: string | null = deps.length === 1 ? (deps[0] ?? null) : null;
      const assigned: string = n.assignedAgent ?? (n.toolId ? "tool" : inferAgent(n.type));
      insert.run(
        id, runId, parentId, ordinal,
        n.type, String(n.title).slice(0, 300), String(n.description ?? "").slice(0, 2000),
        JSON.stringify(deps),
        assigned,
        JSON.stringify(n.input ?? {}),
        JSON.stringify({
          nodeType: n.type,
          toolId: n.toolId ?? null,
          require: n.requireOutputPattern ?? null,
          requireCount: n.requireCount ?? null,
          requireField: n.requireField ?? null,
        }),
        nowIso(),
      );
    }
    return listNodes(config, runId);
  } finally {
    db.close();
  }
}

function inferAgent(type: GraphPlanInput["type"]): string {
  switch (type) {
    case "research": return "researcher";
    case "implementation":
    case "integration":
    case "deploy":
    case "audit":
    case "architecture":
    case "design": return "developer";
    case "qa":
    case "verify": return "qa";
    default: return "researcher";
  }
}

export function listNodes(config: BrainConfig, runId: string): GraphNode[] {
  const db = openDatabase(config.dbPath);
  try {
    const rows = db.prepare("SELECT * FROM graph_nodes WHERE run_id = ? ORDER BY ordinal ASC").all(runId);
    return (rows as unknown[]).map(mapNode);
  } finally {
    db.close();
  }
}

export function getNode(config: BrainConfig, nodeId: string): GraphNode | null {
  const db = openDatabase(config.dbPath);
  try {
    const row = db.prepare("SELECT * FROM graph_nodes WHERE id = ?").get(nodeId);
    return row ? mapNode(row) : null;
  } finally {
    db.close();
  }
}

export function getNodesByStatus(config: BrainConfig, runId: string, status: GraphNodeStatus): GraphNode[] {
  return listNodes(config, runId).filter((n) => n.status === status);
}

export function updateNode(
  config: BrainConfig,
  nodeId: string,
  patch: {
    status?: GraphNodeStatus;
    output?: Record<string, unknown> | null;
    error?: string | null;
    retryCount?: number;
    iteration?: number;
    parallelGroup?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    evidence?: Array<{ kind: string; value: string }>;
    sessionId?: string | null;
    assignedAgent?: string | null;
  },
): GraphNode | null {
  const db = openDatabase(config.dbPath);
  try {
    const node = getNode(config, nodeId);
    if (!node) return null;
    const next: GraphNode = {
      ...node,
      status: patch.status ?? node.status,
      output: patch.output !== undefined ? patch.output : node.output,
      error: patch.error !== undefined ? patch.error : node.error,
      retryCount: patch.retryCount ?? node.retryCount,
      iteration: patch.iteration ?? node.iteration,
      parallelGroup: patch.parallelGroup !== undefined ? patch.parallelGroup : node.parallelGroup,
      startedAt: patch.startedAt !== undefined ? patch.startedAt : node.startedAt,
      completedAt: patch.completedAt !== undefined ? patch.completedAt : node.completedAt,
      evidence: patch.evidence ?? node.evidence,
      sessionId: patch.sessionId !== undefined ? patch.sessionId : node.sessionId,
      assignedAgent: patch.assignedAgent !== undefined ? patch.assignedAgent : node.assignedAgent,
      updatedAt: nowIso(),
    };
    db.prepare(
      `UPDATE graph_nodes SET status = ?, output_json = ?, error = ?, retry_count = ?,
        iteration = ?, parallel_group = ?, started_at = ?, completed_at = ?,
        evidence_json = ?, session_id = ?, assigned_agent = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      next.status,
      JSON.stringify(next.output ?? {}),
      next.error,
      next.retryCount,
      next.iteration,
      next.parallelGroup,
      next.startedAt,
      next.completedAt,
      JSON.stringify(next.evidence),
      next.sessionId,
      next.assignedAgent,
      next.updatedAt,
      nodeId,
    );
    return next;
  } finally {
    db.close();
  }
}

export function touchRun(config: BrainConfig, runId: string): void {
  const db = openDatabase(config.dbPath);
  try {
    db.prepare("UPDATE graph_runs SET updated_at = ? WHERE id = ?").run(nowIso(), runId);
  } finally {
    db.close();
  }
}

// ── Observability ──────────────────────────────────────────────────────

export function recordNodeEvent(config: BrainConfig, runId: string, nodeId: string, event: string, payload: Record<string, unknown> = {}): void {
  const db = openDatabase(config.dbPath);
  try {
    db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('graph_node', ?, ?)").run(
      nodeId,
      JSON.stringify({ run_id: runId, event, ...payload }),
    );
  } finally {
    db.close();
  }
}

/**
 * Run-level telemetry with the standard FASE 3.6 event names
 * (GRAPH_CREATED, GRAPH_STARTED, GRAPH_COMPLETED, GRAPH_FAILED, GRAPH_BLOCKED,
 * GRAPH_RECOVERED, NODE_READY, NODE_STARTED, NODE_COMPLETED, NODE_FAILED,
 * NODE_REWORK, NODE_RETRY, GRAPH_EVALUATED). Each row carries timestamp
 * (occurred_at), graph_id, node_id, session_id, agent_id and provenance.
 */
export function recordRunEvent(
  config: BrainConfig,
  runId: string,
  event: string,
  payload: { nodeId?: string; sessionId?: string | null; agentId?: string | null; extra?: Record<string, unknown> } = {},
): void {
  const db = openDatabase(config.dbPath);
  try {
    const run = db.prepare("SELECT session_key, status FROM graph_runs WHERE id = ?").get(runId) as { session_key?: string } | undefined;
    db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('graph_run', ?, ?)").run(
      runId,
      JSON.stringify({
        event,
        graph_id: runId,
        node_id: payload.nodeId ?? null,
        session_id: payload.sessionId ?? run?.session_key ?? null,
        agent_id: payload.agentId ?? null,
        provenance: "local:orchestration",
        ...(payload.extra ?? {}),
      }),
    );
  } finally {
    db.close();
  }
}

export function nodeHistory(config: BrainConfig, runId: string): Array<{ nodeId: string; event: string; at: string }> {
  const db = openDatabase(config.dbPath);
  try {
    const rows = db.prepare(
      "SELECT subject AS nodeId, json_extract(payload, '$.event') AS event, occurred_at AS at FROM events WHERE event_type = 'graph_node' AND json_extract(payload, '$.run_id') = ? ORDER BY id ASC",
    ).all(runId) as Array<{ nodeId: string; event: string; at: string }>;
    return rows;
  } finally {
    db.close();
  }
}

// ── Mappers ────────────────────────────────────────────────────────────

function mapRun(row: unknown): GraphRun {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    sessionKey: String(r.session_key ?? ""),
    request: String(r.request ?? ""),
    goal: String(r.goal ?? ""),
    status: r.status as GraphRunStatus,
    planner: (r.planner ?? "rule") as "rule" | "llm",
    projectId: r.project_id ? String(r.project_id) : null,
    maxParallel: Number(r.max_parallel),
    maxRetries: Number(r.max_retries),
    maxIterations: Number(r.max_iterations),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
    completedAt: r.completed_at ? String(r.completed_at) : null,
    result: safeJson(r.result_json, {}),
  };
}

function mapNode(row: unknown): GraphNode {
  const r = row as Record<string, unknown>;
  return {
    id: String(r.id),
    runId: String(r.run_id),
    parentId: r.parent_id ? String(r.parent_id) : null,
    ordinal: Number(r.ordinal),
    type: r.type as GraphNode["type"],
    title: String(r.title ?? ""),
    description: String(r.description ?? ""),
    status: r.status as GraphNodeStatus,
    dependencies: safeJson(r.dependencies_json ?? r.dependencies, []),
    assignedAgent: r.assigned_agent ? String(r.assigned_agent) : null,
    sessionId: r.session_id ? String(r.session_id) : null,
    input: safeJson(r.input_json, {}),
    output: r.output_json ? safeJson(r.output_json, null) : null,
    error: r.error ? String(r.error) : null,
    retryCount: Number(r.retry_count ?? 0),
    iteration: Number(r.iteration ?? 0),
    parallelGroup: r.parallel_group ? String(r.parallel_group) : null,
    startedAt: r.started_at ? String(r.started_at) : null,
    completedAt: r.completed_at ? String(r.completed_at) : null,
    evidence: safeJson(r.evidence_json, []),
    evaluate: safeJson(r.evaluate_json, {}),
    updatedAt: String(r.updated_at),
  };
}

function safeJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined || raw === "") return fallback;
  try {
    return JSON.parse(String(raw)) as T;
  } catch {
    return fallback;
  }
}