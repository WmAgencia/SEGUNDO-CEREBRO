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
import { updateRunStatus, touchRun, updateNode, recordNodeEvent, recordRunEvent, listNodes } from "./graph-store.ts";
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

/**
 * Retomada real de um run interrompido (FASE 3.6): após recovery marcar o run
 * como BLOCKED, esta função prepara o run para re-executar apenas o que ainda
 * não foi concluído — nunca duplica uma ação já confirmada como COMPLETED.
 *
 * Regras:
 *   - nós COMPLETED permanecem COMPLETED (nunca re-executados);
 *   - nós RUNNING/READY/PENDING/REWORK voltam a READY (re-executam);
 *   - nós BLOCKED por causa do recovery stale voltam a READY (interrompidos,
 *     não falharam de verdade);
 *   - nós FAILED/CANCELLED e nós BLOCKED por dependência falha permanecem
 *     BLOCKED (denunciam problema real);
 *   - o run volta a PLANNED para o executor re-agendar.
 */
export function prepareResume(config: BrainConfig, runId: string): { resumedNodes: number; keptCompleted: number; blockedNodes: number } {
  const db = openDatabase(config.dbPath);
  const result = { resumedNodes: 0, keptCompleted: 0, blockedNodes: 0 };
  try {
    const run = db.prepare("SELECT status, session_key FROM graph_runs WHERE id = ?").get(runId) as
      | { status: string; session_key: string }
      | undefined;
    if (!run) throw new Error(`run not found: ${runId}`);
    if (run.status !== "BLOCKED" && run.status !== "FAILED" && run.status !== "PLANNED" && run.status !== "RUNNING") {
      throw new Error(`run ${runId} está em ${run.status} e não pode ser retomado`);
    }

    let hasFailedDep = false;
    const nodes = listNodes(config, runId);
    const failedIds = new Set(nodes.filter((n) => n.status === "FAILED").map((n) => n.id));
    for (const node of nodes) {
      if (node.status === "COMPLETED") { result.keptCompleted += 1; continue; }
      const depFailed = node.dependencies.some((d) => failedIds.has(d));
      if (depFailed) {
        updateNode(config, node.id, { status: "BLOCKED", error: "dependência falhou" });
        result.blockedNodes += 1;
        hasFailedDep = true;
        continue;
      }
      if (node.status === "RUNNING" || node.status === "READY" || node.status === "PENDING" || node.status === "REWORK"
        || (node.status === "BLOCKED" && (node.error ?? "").toLowerCase().includes("stale"))) {
        updateNode(config, node.id, { status: "READY", error: null });
        recordNodeEvent(config, runId, node.id, "resumed_from_recovery", { at: new Date().toISOString() });
        result.resumedNodes += 1;
      } else {
        updateNode(config, node.id, { status: "BLOCKED" });
        result.blockedNodes += 1;
      }
    }

    const finalStatus = hasFailedDep ? "FAILED" : "PLANNED";
    updateRunStatus(config, runId, finalStatus, { resumed: true, at: new Date().toISOString(), blockedNodes: result.blockedNodes });
    touchRun(config, runId);
    recordRunEvent(config, runId, "GRAPH_RECOVERED", {
      sessionId: run.session_key,
      extra: { action: "resume", resumedNodes: result.resumedNodes, keptCompleted: result.keptCompleted, runStatus: finalStatus },
    });
    return result;
  } finally {
    db.close();
  }
}

export { DatabaseSync };