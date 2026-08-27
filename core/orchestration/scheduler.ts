/**
 * Scheduler — reads the graph state and decides readiness and parallelism.
 *
 * Readiness: a node is READY when all its dependencies are COMPLETED (and none
 * failed/blocked/cancelled). A node becomes BLOCKED when any dependency
 * FAILED/BLOCKED — the run then can't make progress through that path.
 *
 * Parallelism: ready nodes are returned up to `maxParallel`, and the executor
 * records a shared parallel_group for siblings running in the same wave.
 * Parallelism ONLY when dependency(a,b)=false (already guaranteed by readiness).
 */

import { GraphNode, GraphNodeStatus } from "./types.ts";

const BLOCKABLE: readonly GraphNodeStatus[] = ["FAILED", "BLOCKED", "CANCELLED"];

function depStatus(node: GraphNode, byId: Map<string, GraphNode>): Array<GraphNodeStatus | "MISSING"> {
  return node.dependencies.map((d) => byId.get(d)?.status ?? "MISSING");
}

export interface ScheduleResult {
  ready: GraphNode[];
  blocked: GraphNode[];
  pendingCount: number;
  complete: boolean;
  stalled: boolean;
}

export function schedule(nodes: GraphNode[], maxParallel: number): ScheduleResult {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ready: GraphNode[] = [];
  const blocked: GraphNode[] = [];
  let completedCount = 0;

  for (const node of nodes) {
    if (node.status === "COMPLETED") { completedCount++; continue; }

    const deps = depStatus(node, byId);
    if (!deps.length) {
      if (node.status === "PENDING" || node.status === "READY" || node.status === "REWORK") ready.push(node);
      continue;
    }
    const anyBlocked = deps.some((s) => (BLOCKABLE as readonly string[]).includes(s));
    if (anyBlocked) {
      if (node.status === "PENDING" || node.status === "READY" || node.status === "REWORK") {
        blocked.push(node);
      }
      continue;
    }
    if (deps.some((s) => s === "MISSING")) {
      blocked.push(node); // unknown dependency — cannot resolve
      continue;
    }
    if (deps.every((s) => s === "COMPLETED")) {
      if (node.status === "PENDING" || node.status === "READY" || node.status === "REWORK" || node.status === "RUNNING") {
        ready.push(node);
      }
    }
  }

  const stalled = nodes.some((n) => n.status === "RUNNING" || n.status === "REWORK");
  const complete = completedCount === nodes.length;

  return {
    ready: ready.slice(0, Math.max(0, maxParallel)),
    blocked,
    pendingCount: nodes.length - completedCount,
    complete,
    stalled,
  };
}

export function assignParallelGroups(selected: GraphNode[], wave: number): Map<string, string | null> {
  const out = new Map<string, string | null>();
  if (selected.length <= 1) {
    out.set(selected[0]?.id ?? "", null);
    return out;
  }
  const group = `wave.${wave}`;
  for (const n of selected) out.set(n.id, group);
  return out;
}