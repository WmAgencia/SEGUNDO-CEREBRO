import { DatabaseSync } from "node:sqlite";

/**
 * RUNTIME OPS — heartbeat, orphan detection e evidence gate.
 * Complementa agent-os sem alterar contratos legados.
 */

/* ─────────────── HEARTBEAT / ORPHANS ─────────────── */

export function touchHeartbeat(db: DatabaseSync, runId: string): void {
  db.prepare(
    "UPDATE agent_runs SET heartbeat_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
  ).run(runId);
}

export interface OrphanReport {
  detected: string[];
  recovered: string[];
  failed: string[];
}

/**
 * Detecta runs RUNNING/PLANNING/EVALUATING/REWORKING cujo heartbeat expirou.
 * Orphans são marcados ORPHANED; a task volta para READY (requeue) quando
 * existir, preservando o histórico — nunca fake-success.
 */
export function detectOrphanedRuns(
  db: DatabaseSync,
  opts: { timeoutMinutes?: number; now?: Date } = {},
): OrphanReport {
  const timeoutMinutes = opts.timeoutMinutes ?? Number(process.env.RUNTIME_HEARTBEAT_TIMEOUT_MIN ?? "10");
  const now = opts.now ?? new Date();
  const cutoff = new Date(now.getTime() - timeoutMinutes * 60_000).toISOString();

  const stale = db.prepare(
    `SELECT id, task_id FROM agent_runs
     WHERE state IN ('RUNNING','PLANNING','EVALUATING','REWORKING')
       AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
  ).all(cutoff) as unknown as Array<{ id: string; task_id: number | null }>;

  const report: OrphanReport = { detected: [], recovered: [], failed: [] };
  for (const run of stale) {
    report.detected.push(run.id);
    db.prepare(
      "UPDATE agent_runs SET state='ORPHANED', previous_state=state, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).run(run.id);
    db.prepare(
      "INSERT INTO events (event_type, subject, payload) VALUES ('run.orphaned', ?, ?)",
    ).run(run.id, JSON.stringify({ taskId: run.task_id, timeoutMinutes }));
    if (run.task_id) {
      db.prepare(
        "UPDATE initiative_tasks SET status='READY', assigned_agent=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('RUNNING','ASSIGNED')",
      ).run(run.task_id);
      report.recovered.push(String(run.task_id));
    }
  }
  return report;
}

/* ─────────────── EVIDENCE GATE ─────────────── */

export interface EvidenceInput {
  summary: string;
  output: string;
  artifacts?: string[];
  sources?: string[];
}

export type EvidenceVerdict =
  | { ok: true }
  | { ok: false; reason: string };

const MIN_OUTPUT_CHARS = 40;

/**
 * REGRA CRÍTICA: agente não pode apenas "dizer que fez".
 * Evidência mínima exigida: output substantivo + ≥1 artifact OU ≥1 source.
 */
export function checkEvidence(input: EvidenceInput): EvidenceVerdict {
  if (!input.output || input.output.trim().length < MIN_OUTPUT_CHARS) {
    return { ok: false, reason: `output com menos de ${MIN_OUTPUT_CHARS} caracteres úteis` };
  }
  const artifacts = input.artifacts?.filter((a) => a.trim() !== "") ?? [];
  const sources = input.sources?.filter((s) => s.trim() !== "") ?? [];
  if (artifacts.length === 0 && sources.length === 0) {
    return { ok: false, reason: "nenhum artifact ou source produzido — resultado NOT VERIFIED" };
  }
  return { ok: true };
}

export interface SubmitWithEvidenceResult {
  submitted: boolean;
  verdict: EvidenceVerdict;
}

/**
 * Wrapper para fluxos Runtime2 (n8n, prospector, workers novos):
 * recusa resultado sem evidência ANTES de chegar ao submitResult.
 * O caminho legado agent-os.submitResult permanece intacto.
 */
export function requireEvidence<T extends EvidenceInput>(
  input: T,
): SubmitWithEvidenceResult {
  const verdict = checkEvidence(input);
  return { submitted: verdict.ok, verdict };
}
