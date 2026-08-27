/**
 * Graph validator — validates a node list as a DAG.
 *
 * Checks: duplicate ids, empty id/title, unknown dependencies,
 * self-dependencies and cycles. Returns the list of validation errors
 * (empty array = valid DAG).
 */

import type { GraphPlanInput } from "./types.ts";

export interface GraphValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateGraph(nodes: GraphPlanInput[]): GraphValidationResult {
  const errors: string[] = [];
  const ids = new Set<string>();
  const byId = new Map<string, GraphPlanInput>();

  if (!Array.isArray(nodes)) return { ok: false, errors: ["nodes must be an array"] };
  if (nodes.length === 0) return { ok: false, errors: ["graph with no nodes"] };

  for (const node of nodes) {
    if (!node?.id || String(node.id).trim() === "") errors.push("node with empty id");
    else if (ids.has(node.id)) errors.push(`duplicate node id: ${node.id}`);
    else { ids.add(node.id); byId.set(node.id, node); }

    if (!node?.title || String(node.title).trim() === "") errors.push(`node ${node.id ?? "?"} has empty title`);
    if (node.dependencies !== undefined && !Array.isArray(node.dependencies)) errors.push(`node ${node.id ?? "?"} dependencies must be an array`);
  }

  // resolve references only after the id pass so duplicate ids are not addressed twice
  for (const node of nodes) {
    if (!node || !node.id) continue;
    for (const dep of node.dependencies ?? []) {
      if (dep === node.id) errors.push(`node ${node.id} cannot depend on itself`);
      else if (!byId.has(dep)) errors.push(`node ${node.id} depends on unknown node: ${dep}`);
    }
  }

  // cycle detection (DFS)
  const color = new Map<string, 0 | 1 | 2>();
  const visiting: string[] = [];
  const visit = (id: string): boolean => {
    const c = color.get(id);
    if (c === 1) return true; // back edge → cycle
    if (c === 2) return false;
    color.set(id, 1);
    visiting.push(id);
    const node = byId.get(id);
    for (const dep of node?.dependencies ?? []) {
      if (visit(dep)) return true;
    }
    color.set(id, 2);
    visiting.pop();
    return false;
  };
  for (const id of ids) {
    if (visit(id)) {
      errors.push(`cycle detected: ${[...visiting, id].join(" → ")}`);
      break;
    }
  }

  return { ok: errors.length === 0, errors };
}