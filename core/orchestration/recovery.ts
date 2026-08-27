/**
 * Recovery — a run can never stay RUNNING forever.
 *
 * On startup (and on demand), detect stale runs:
 *   - a run whose updated_at is older than the stale threshold while still
 *     RUNNING/PLANNED, or
 *   - a node stuck in RUNNING (started but never finished).
 * Recovery marks the run BLOCKED with a clear reason and blocks its RUNNING
 * nodes, so the system never pretends work is in flight when the process died.
 *
 * Safe-by-default: it never auto-resumes risky work — it BLOCKS it, so a human
 * (or an explicit graph_execute resume) decides next steps.
 */

import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { openDatabase } from "../../storage/connection.ts";
import { updateRunStatus, touchRun, updateNode, recordNodeEvent, listNodes } from "./graph-store.ts";
import { orchestrationLimits } from "./types.ts";

export interface RecoveredRun {
  runId: string;
  reason: string;
  action: "blocked";
  affectedNodes: number;
}

export function detectStaleRuns(config: BrainConfig, opts?: { now?: number; staleAfterMs?: number }): Array<{ id: string; staleAgeMs: number }> {
  const limits = orchestrationLimits();
  const staleAfterMs = opts?.staleAfterMs ?? limits.staleAfterMs;
  const now = opts?.now ?? Date.now();
  const db = openDatabase(config.dbPath);
  try {
    const rows = db.prepare(
      "SELECT id, updated_at FROM graph_runs WHERE status IN ('PLANNED', 'RUNNING')",
    ).all() as Array<{ id: string; updated_at: string }>;
    return rows
      .filter((r) => {
        const t = Date.parse(r.updated_at);
        return Number.isFinite(t) && now - t > staleAfterMs;
      })
      .map((r) => ({ id: r.id, staleAgeMs: now - Date.parse(r.updated_at) }));
  } finally {
    db.close();
  }
}

export function recoverStaleRuns(config: BrainConfig, opts?: { now?: number; staleAfterMs?: number }): RecoveredRun[] {
  const stale = detectStaleRuns(config, opts);
  const recovered: RecoveredRun[] = [];
  for (const run of stale) {
    const nodes = listNodes(config, run.id);
    let affected = 0;
    for (const node of nodes) {
      if (node.status === "RUNNING" || node.status === "READY" || node.status === "PENDING" || node.status === "REWORK") {
        updateNode(config, node.id, {
          status: "BLOCKED",
          error: `run stale (processo interrompido há ${Math.round(run.staleAgeMs / 1000)}s)`,
        });
        recordNodeEvent(config, run.id, node.id, "blocked_stale", { reason: "stale run recovery" });
        affected += 1;
      }
    }
    const reason = `run ${run.id} estava ${affected > 0 ? `com ${affected} nós` : "em andamento"} e ficou sem atualização por ${Math.round(run.staleAgeMs / 1000)}s — marcado como BLOCKED p/ revisão humana.`;
    updateRunStatus(config, run.id, "BLOCKED", { recovery: reason });
    touchRun(config, run.id);
    recovered.push({ runId: run.id, reason, action: "blocked", affectedNodes: affected });
  }
  return recovered;
}

export function recoverAtStartup(config: BrainConfig, staleAfterMs = orchestrationLimits().staleAfterMs): RecoveredRun[] {
  return recoverStaleRuns(config, { staleAfterMs });
}

export function markStaleForTest(config: BrainConfig, runId: string, oldTimestampIso: string): void {
  const db = openDatabase(config.dbPath);
  try {
    db.prepare("UPDATE graph_runs SET updated_at = ? WHERE id = ?").run(oldTimestampIso, runId);
  } finally {
    db.close();
  }
}

export { DatabaseSync };