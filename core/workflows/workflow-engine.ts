import { DatabaseSync } from "node:sqlite";
import { NotFoundError, ValidationError } from "../errors/errors.ts";

export type WorkflowStatus = "DRAFT" | "READY" | "RUNNING" | "WAITING" | "BLOCKED" | "FAILED" | "COMPLETED" | "CANCELLED";
export type StepType = "OBSERVE" | "RESEARCH" | "PLAN" | "CONSULT" | "DEBATE" | "DECIDE" | "EXECUTE" | "REVIEW" | "REWORK" | "WAIT_APPROVAL" | "NOTIFY" | "COMPLETE";

export function createWorkflow(
  db: DatabaseSync,
  input: { name: string; initiativeId?: string; steps: Array<{ type: StepType; title: string; agentId?: string }> },
): { id: number; stepCount: number } {
  if (!input.name.trim()) throw new ValidationError("workflow name required");
  if (!input.steps || input.steps.length === 0) throw new ValidationError("at least one step required");

  const inserted = db
    .prepare("INSERT INTO workflows (name, initiative_id, status) VALUES (?, ?, 'READY')")
    .run(input.name, input.initiativeId ?? null);
  const workflowId = Number(inserted.lastInsertRowid);

  const insertStep = db.prepare(
    "INSERT INTO workflow_steps (workflow_id, ordinal, type, title, agent_id) VALUES (?, ?, ?, ?, ?)",
  );
  let prevId: number | null = null;
  for (const [i, step] of input.steps.entries()) {
    insertStep.run(workflowId, i + 1, step.type, step.title, step.agentId ?? null);
    void prevId;
  }

  return { id: workflowId, stepCount: input.steps.length };
}

export function startWorkflowRun(db: DatabaseSync, workflowId: number): number {
  const wf = db
    .prepare("SELECT status FROM workflows WHERE id=?")
    .get(workflowId) as { status: string } | undefined;
  if (!wf) throw new ValidationError(`workflow not found: ${workflowId}`);
  if (wf.status !== "READY") throw new ValidationError(`workflow must be READY to start`);

  db.prepare("UPDATE workflows SET status='RUNNING' WHERE id=?").run(workflowId);
  const inserted = db
    .prepare(
      `INSERT INTO workflow_runs (workflow_id, status, checkpoint) VALUES (?, 'RUNNING', '{}')`,
    )
    .run(workflowId);
  return Number(inserted.lastInsertRowid);
}

export interface WorkflowProgress {
  runId: number;
  totalSteps: number;
  completedSteps: number;
  progressPct: number;
  currentStep: { ordinal: number; type: string; title: string } | null;
}

export function getWorkflowProgress(db: DatabaseSync, runId: number): WorkflowProgress {
  const run = db
    .prepare("SELECT * FROM workflow_runs WHERE id = ?")
    .get(runId) as Record<string, unknown> | undefined;
  if (!run) throw new NotFoundError(`run not found: ${runId}`);
  const workflowId = Number(run.workflow_id);

  const total = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM workflow_steps WHERE workflow_id=?").get(workflowId) as { c: number }).c,
  );
  const done = Number(
    (db.prepare("SELECT COUNT(*) AS c FROM workflow_steps WHERE workflow_id=? AND status='COMPLETED'").get(workflowId) as { c: number }).c,
  );

  const current = db
    .prepare(
      `SELECT ordinal, type, title FROM workflow_steps
       WHERE workflow_id=? AND status != 'COMPLETED' ORDER BY ordinal LIMIT 1`,
    )
    .get(workflowId) as { ordinal: number; type: string; title: string } | undefined;

  return {
    runId,
    totalSteps: total,
    completedSteps: done,
    progressPct: total === 0 ? 0 : Math.round((done / total) * 100),
    currentStep: current ?? null,
  };
}
