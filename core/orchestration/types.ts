/**
 * Graph Orchestration — types and limits.
 *
 * The Single Agent decides WHAT to do; the Graph decides the ORDER (DAG),
 * the Scheduler decides readiness/parallelism; subagents decide HOW;
 * the Evaluator decides if a node really worked (evidence, never "LLM disse").
 */

export type GraphNodeStatus =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "BLOCKED"
  | "FAILED"
  | "REWORK"
  | "COMPLETED"
  | "CANCELLED";

export type GraphRunStatus =
  | "PLANNED"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

export type GraphNodeType =
  | "tool"
  | "subagent"
  | "llm"
  | "audit"
  | "research"
  | "design"
  | "architecture"
  | "implementation"
  | "integration"
  | "qa"
  | "deploy"
  | "verify"
  | "task";

export interface GraphNode {
  id: string;
  runId: string;
  parentId: string | null;
  ordinal: number;
  type: GraphNodeType;
  title: string;
  description: string;
  status: GraphNodeStatus;
  dependencies: string[];
  assignedAgent: string | null;
  sessionId: string | null;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: string | null;
  retryCount: number;
  iteration: number;
  parallelGroup: string | null;
  startedAt: string | null;
  completedAt: string | null;
  evidence: Array<{ kind: string; value: string }>;
  evaluate: { criterion?: string; require?: string; toolId?: string; nodeType?: GraphNodeType };
  updatedAt: string;
}

export interface GraphRun {
  id: string;
  sessionKey: string;
  request: string;
  goal: string;
  status: GraphRunStatus;
  planner: "rule" | "llm";
  projectId: string | null;
  maxParallel: number;
  maxRetries: number;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  result: Record<string, unknown>;
}

export interface GraphPlanInput {
  id: string;
  title: string;
  description?: string;
  type: GraphNodeType;
  dependencies?: string[];
  assignedAgent?: string;
  input?: Record<string, unknown>;
  toolId?: string;
  requireOutputPattern?: string;
}

export interface GraphPlan {
  goal: string;
  projectId?: string | null;
  nodes: GraphPlanInput[];
}

export interface EvaluateVerdict {
  pass: boolean;
  reason: string;
  evidence: Array<{ kind: string; value: string }>;
}

/** Orchestration limits live in limits.ts (env-configurable, conservative). */
export { orchestrationLimits } from "./limits.ts";

export const FINAL_NODE_STATUSES: readonly GraphNodeStatus[] = ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"];

export function isFinal(status: GraphNodeStatus): boolean {
  return (FINAL_NODE_STATUSES as readonly string[]).includes(status);
}