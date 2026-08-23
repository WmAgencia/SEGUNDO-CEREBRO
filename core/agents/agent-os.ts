import { DatabaseSync } from "node:sqlite";
import { NotFoundError, ValidationError } from "../errors/errors.ts";
import type { BrainConfig } from "../config/loader.ts";
import { getInitiative } from "../goals/initiatives.ts";
import { getGoal, updateGoal } from "../goals/goal-engine.ts";
import { addObservation } from "../goals/funnel.ts";

const SRC = "src.system";

export const TASK_STATUSES = [
  "PENDING", "READY", "ASSIGNED", "RUNNING", "WAITING",
  "BLOCKED", "COMPLETED", "FAILED", "CANCELLED",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const AGENT_STATUSES = [
  "IDLE", "AVAILABLE", "ASSIGNED", "PLANNING", "WORKING",
  "WAITING", "BLOCKED", "HANDOFF", "COMPLETED", "FAILED", "PAUSED",
] as const;

interface TaskRow {
  id: number;
  initiative_id: string;
  ordinal: number;
  title: string;
  depends_on: number | null;
  assigned_agent: string | null;
  status: string;
  priority: number | null;
}

function logEvent(
  db: DatabaseSync,
  eventType: string,
  subject: string | null,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES (?, ?, ?)`,
  ).run(eventType, subject, JSON.stringify(payload));
}

function getTaskRow(db: DatabaseSync, taskId: number): TaskRow {
  const row = db
    .prepare("SELECT * FROM initiative_tasks WHERE id = ?")
    .get(taskId) as unknown as TaskRow | undefined;
  if (!row) throw new NotFoundError(`task not found: ${taskId}`);
  return row;
}

export function setAgentStatus(
  db: DatabaseSync,
  agentId: string,
  status: string,
): void {
  db.prepare("UPDATE agents SET status = ? WHERE id = ?").run(status.toUpperCase(), agentId);
  logEvent(db, `agent_${status.toLowerCase()}`, agentId, {});
}

export function adjustWorkload(db: DatabaseSync, agentId: string, delta: number): void {
  db.prepare(
    "UPDATE agents SET workload = MAX(0, workload + ?) WHERE id = ?",
  ).run(delta, agentId);
}

export function listAgentsFiltered(
  db: DatabaseSync,
  filters: { status?: string; capability?: string; projectId?: string; availableOnly?: boolean } = {},
): Array<Record<string, unknown>> {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (filters.status) {
    where.push("status = ?");
    values.push(filters.status.toUpperCase());
  }
  if (filters.capability) {
    where.push("(capabilities LIKE ? OR domains LIKE ?)");
    values.push(`%"${filters.capability}"%`, `%"${filters.capability}"%`);
  }
  if (filters.projectId) {
    where.push("(projects = ? OR projects LIKE ? OR projects = '[]')");
    values.push(`"${filters.projectId}"`, `%"${filters.projectId}"%`);
  }
  if (filters.availableOnly) {
    where.push("status IN ('IDLE','AVAILABLE') AND workload < capacity");
  }
  const sql = `SELECT * FROM agents ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`;
  return db.prepare(sql).all(...values) as unknown as Array<Record<string, unknown>>;
}

export interface AgentCandidate {
  agentId: string;
  score: number;
  reasons: string[];
}

export function selectAgent(
  db: DatabaseSync,
  args: {
    requiredSkills?: string[];
    requiredTools?: string[];
    projectId?: string;
    capabilityTokens?: string[];
    excludeAgents?: string[];
  },
): AgentCandidate | null {
  const rows = db
    .prepare(
      `SELECT * FROM agents WHERE status IN ('IDLE','AVAILABLE')
       AND workload < capacity`,
    )
    .all() as unknown as Array<Record<string, unknown>>;

  const candidates: AgentCandidate[] = [];
  for (const raw of rows) {
    const id = String(raw.id);
    if (args.excludeAgents?.includes(id)) continue;

    let score = 40;
    const reasons: string[] = ["disponível"];

    const capabilities = parseJsonArr(String(raw.capabilities ?? "[]"));
    const skills = parseJsonArr(String(raw.skills ?? "[]"));
    const tools = parseJsonArr(String(raw.tools ?? "[]"));
    const projects = parseJsonArr(String(raw.projects ?? "[]"));

    const capHits = (args.capabilityTokens ?? []).filter((t) =>
      capabilities.some((c) => c.toLowerCase().includes(t.toLowerCase())),
    );
    if (args.capabilityTokens && args.capabilityTokens.length > 0) {
      if (capHits.length > 0) {
        score += 20;
        reasons.push(`capability match (${capHits.join(", ")})`);
      } else {
        continue;
      }
    }

    const skillHits = (args.requiredSkills ?? []).filter((s) =>
      skills.some((x) => x.toLowerCase() === s.toLowerCase()),
    );
    if ((args.requiredSkills?.length ?? 0) > 0) {
      if (skillHits.length > 0) {
        score += 15;
        reasons.push(`skill match (${skillHits.join(", ")})`);
      } else {
        continue;
      }
    }

    const toolHits = (args.requiredTools ?? []).filter((t) =>
      tools.some((x) => x.toLowerCase().includes(t.toLowerCase())),
    );
    if ((args.requiredTools?.length ?? 0) > 0) {
      if (toolHits.length === args.requiredTools?.length) {
        score += 10;
        reasons.push("tools cobertas");
      } else {
        continue;
      }
    }

    if (args.projectId) {
      if (projects.length === 0 || projects.includes(args.projectId)) {
        score += 10;
        reasons.push("projeto autorizado");
      } else {
        continue;
      }
    }

    const workload = Number(raw.workload ?? 0);
    const capacity = Number(raw.capacity ?? 3);
    score += Math.max(0, 10 - workload * 5);
    reasons.push(`workload ${workload}/${capacity}`);

    candidates.push({
      agentId: id,
      score: Math.round(score),
      reasons,
    });
  }

  candidates.sort((a, b) => b.score - a.score || a.agentId.localeCompare(b.agentId));
  return candidates[0] ?? null;
}

function parseJsonArr(raw: string): string[] {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function refreshQueue(db: DatabaseSync, initiativeId: string): number[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.depends_on, d.status AS dep_status
       FROM initiative_tasks t
       LEFT JOIN initiative_tasks d ON d.id = t.depends_on
       WHERE t.initiative_id = ? AND t.status = 'PENDING'`,
    )
    .all(initiativeId) as unknown as Array<{
    id: number;
    depends_on: number | null;
    dep_status: string | null;
  }>;

  const unlocked: number[] = [];
  for (const row of rows) {
    if (row.depends_on === null || row.dep_status === "COMPLETED") {
      db.prepare("UPDATE initiative_tasks SET status = 'READY', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
      logEvent(db, "task_ready", null, { taskId: row.id });
      unlocked.push(row.id);
    }
  }
  return unlocked;
}

export function assignTask(
  db: DatabaseSync,
  taskId: number,
  options: { agentId?: string; reason?: string } = {},
): { taskId: number; agentId: string; reason: string } {
  const task = getTaskRow(db, taskId);
  if (task.status !== "READY" && task.status !== "PENDING") {
    throw new ValidationError(`task ${taskId} não está disponível (status ${task.status})`);
  }

  let agentId = options.agentId;
  let reason = options.reason ?? "";
  if (!agentId) {
    const candidate = selectAgent(db, {
      capabilityTokens: task.title.toLowerCase().split(/\s+/).filter((w) => w.length > 3),
    });
    if (!candidate) throw new ValidationError("nenhum agente disponível para a task");
    agentId = candidate.agentId;
    reason = candidate.reasons.join("; ");
  }

  db.prepare(
    "UPDATE initiative_tasks SET status='ASSIGNED', assigned_agent=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
  ).run(agentId, taskId);
  db.prepare(
    `INSERT INTO task_assignments (task_id, initiative_id, assigned_agent, reason)
     VALUES (?, ?, ?, ?)`,
  ).run(taskId, task.initiative_id, agentId, reason);
  adjustWorkload(db, agentId, 1);
  setAgentStatus(db, agentId, "ASSIGNED");
  logEvent(db, "task_assigned", agentId, { taskId });

  return { taskId, agentId, reason };
}

export function blockTask(
  db: DatabaseSync,
  config: BrainConfig,
  args: {
    taskId: number;
    agentId: string;
    reason: string;
    requiredInput?: string;
    requiredAgent?: string;
    requiredTool?: string;
    requiredApproval?: boolean;
  },
): void {
  const task = getTaskRow(db, args.taskId);
  db.prepare(
    "UPDATE initiative_tasks SET status='BLOCKED', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
  ).run(args.taskId);
  setAgentStatus(db, args.agentId, "BLOCKED");
  sendMessage(db, {
    fromAgent: args.agentId,
    toAgent: "orchestrator",
    type: "BLOCKER",
    subject: `Task ${args.taskId} bloqueada`,
    message: args.reason,
    taskId: args.taskId,
    initiativeId: task.initiative_id,
    contextData: {
      requiredInput: args.requiredInput ?? null,
      requiredAgent: args.requiredAgent ?? null,
      requiredTool: args.requiredTool ?? null,
      requiredApproval: args.requiredApproval ?? false,
    },
  });
  if (args.requiredApproval) {
    requestApproval(db, {
      taskId: args.taskId,
      initiativeId: task.initiative_id,
      agentId: args.agentId,
      type: "EXTERNAL_ACTION",
      reason: args.reason,
    });
  }
  logEvent(db, "agent_blocked", args.agentId, { taskId: args.taskId, reason: args.reason });
}

export function unblockTask(db: DatabaseSync, taskId: number, providedInput: Record<string, unknown>): void {
  db.prepare(
    "UPDATE initiative_tasks SET status='READY', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status='BLOCKED'",
  ).run(taskId);
  sendMessage(db, {
    fromAgent: "orchestrator",
    toAgent: "system",
    type: "STATUS",
    subject: `Task ${taskId} desbloqueada`,
    message: "input fornecido",
    taskId,
    contextData: providedInput,
  });
}

export function startTaskWork(db: DatabaseSync, taskId: number, agentId: string): number {
  const task = getTaskRow(db, taskId);
  const inserted = db
    .prepare(
      `INSERT INTO work_sessions (agent_id, task_id, initiative_id) VALUES (?, ?, ?)`,
    )
    .run(agentId, taskId, task.initiative_id);
  db.prepare(
    "UPDATE initiative_tasks SET status='RUNNING', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
  ).run(taskId);
  setAgentStatus(db, agentId, "WORKING");
  logEvent(db, "task_started", agentId, { taskId });
  return Number(inserted.lastInsertRowid);
}

export interface SubmitResultInput {
  taskId: number;
  agentId: string;
  sessionId?: number;
  summary: string;
  output: string;
  artifacts?: string[];
  sources?: string[];
  confidence?: number;
  requiresReview?: boolean;
  reviewerAgentId?: string;
  metricDelta?: { goalId: string; delta: number };
  nextRecommendedAction?: string;
}

const MAX_RETRIES = 3;

export function submitResult(
  db: DatabaseSync,
  config: BrainConfig,
  input: SubmitResultInput,
): { resultId: number; validation: string; awaitingReview: boolean; reworked: boolean } {
  const task = getTaskRow(db, input.taskId);

  let validation = "VALID";
  if (!input.output || input.output.trim() === "") validation = "INCOMPLETE";
  if (!input.summary || input.summary.trim() === "") validation = "INCOMPLETE";

  const prev = db
    .prepare(
      `SELECT rework_count, id FROM agent_results
       WHERE task_id = ? ORDER BY id DESC LIMIT 1`,
    )
    .get(input.taskId) as
    | { rework_count: number; id: number }
    | undefined;
  const reworkOf =
    prev && (prev.rework_count > 0 || wasRejected(db, prev.id)) ? prev.id : null;
  const reworkCount = reworkOf ? (prev?.rework_count ?? 0) + 1 : 0;

  if (reworkCount >= MAX_RETRIES) {
    db.prepare(
      "UPDATE initiative_tasks SET status='BLOCKED', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).run(input.taskId);
    requestApproval(db, {
      taskId: input.taskId,
      initiativeId: task.initiative_id,
      agentId: input.agentId,
      type: "OTHER",
      reason: `máximo de retentativas (${MAX_RETRIES}) atingido`,
    });
    throw new ValidationError(
      `task ${input.taskId} excedeu máximo de retentativas — escalado para revisão humana`,
    );
  }

  const inserted = db
    .prepare(
      `INSERT INTO agent_results (task_id, session_id, agent_id, status, summary, output,
         artifacts, sources, confidence, metrics, next_recommended_action, rework_of, rework_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.taskId,
      input.sessionId ?? null,
      input.agentId,
      validation,
      input.summary,
      input.output,
      JSON.stringify(input.artifacts ?? []),
      JSON.stringify(input.sources ?? []),
      input.confidence ?? 0.8,
      JSON.stringify({}),
      input.nextRecommendedAction ?? null,
      reworkOf,
      reworkCount,
    );
  const resultId = Number(inserted.lastInsertRowid);

  let awaitingReview = false;
  if (validation !== "VALID") {
    db.prepare(
      "UPDATE initiative_tasks SET status='FAILED', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).run(input.taskId);
    logEvent(db, "task_failed", input.agentId, { taskId: input.taskId, validation });
  } else if (input.requiresReview) {
    awaitingReview = true;
    db.prepare(
      "UPDATE initiative_tasks SET status='WAITING', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).run(input.taskId);
    db.prepare(
      "UPDATE agent_results SET review_status='PENDING' WHERE id=?",
    ).run(resultId);
    requestReview(db, {
      taskId: input.taskId,
      initiativeId: task.initiative_id,
      agentId: input.agentId,
      resultId,
      reviewerAgentId: input.reviewerAgentId,
    });
    setAgentStatus(db, input.agentId, "WAITING");
  } else {
    finalizeCompletion(db, config, input.taskId, input.agentId, resultId);
  }

  if (input.metricDelta) {
    reportOutcome(db, input.metricDelta.goalId, input.metricDelta.delta);
  }

  endSessionIfAny(db, input.sessionId, {
    outputs: { summary: input.summary },
    errors: validation === "VALID" ? [] : [validation],
  });

  return { resultId, validation, awaitingReview, reworked: reworkCount > 0 };
}

function wasRejected(db: DatabaseSync, resultId: number): boolean {
  const row = db
    .prepare("SELECT review_status FROM agent_results WHERE id = ?")
    .get(resultId) as { review_status: string } | undefined;
  return row?.review_status === "REJECTED";
}

function endSessionIfAny(
  db: DatabaseSync,
  sessionId: number | undefined,
  data: { outputs: Record<string, unknown>; errors: string[] },
): void {
  if (!sessionId) return;
  db.prepare(
    `UPDATE work_sessions SET ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       status='COMPLETED', outputs=?, errors=? WHERE id=?`,
  ).run(JSON.stringify(data.outputs), JSON.stringify(data.errors), sessionId);
}

function finalizeCompletion(
  db: DatabaseSync,
  config: BrainConfig,
  taskId: number,
  agentId: string,
  resultId: number,
): void {
  db.prepare(
    "UPDATE initiative_tasks SET status='COMPLETED', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
  ).run(taskId);
  adjustWorkload(db, agentId, -1);
  logEvent(db, "task_completed", agentId, { taskId, resultId });
  refreshQueue(db, initiativeOfTask(db, taskId));
  void config;
}

function initiativeOfTask(db: DatabaseSync, taskId: number): string {
  const row = db
    .prepare("SELECT initiative_id FROM initiative_tasks WHERE id = ?")
    .get(taskId) as { initiative_id: string };
  return row.initiative_id;
}

export function requestReview(
  db: DatabaseSync,
  args: { taskId: number; initiativeId: string; agentId: string; resultId: number; reviewerAgentId?: string },
): number {
  const inserted = db
    .prepare(
      `INSERT INTO approvals (task_id, initiative_id, agent_id, type, reason)
       VALUES (?, ?, ?, 'CONTENT', 'revisão de resultado solicitada')`,
    )
    .run(args.taskId, args.initiativeId, args.agentId);
  logEvent(db, "review_requested", args.agentId, { taskId: args.taskId, resultId: args.resultId });
  return Number(inserted.lastInsertRowid);
}

export function resolveReview(
  db: DatabaseSync,
  config: BrainConfig,
  args: { approvalId: number; decision: "APPROVED" | "REJECTED"; by: string; feedback?: string },
): { taskCompleted: boolean; reworked: boolean } {
  const approval = db
    .prepare("SELECT * FROM approvals WHERE id = ?")
    .get(args.approvalId) as
    | Record<string, unknown>
    | undefined;
  if (!approval) throw new NotFoundError(`approval not found: ${args.approvalId}`);
  if (approval.status !== "PENDING") {
    throw new ValidationError("approval já resolvida");
  }

  const taskId = Number(approval.task_id);
  const agentId = String(approval.agent_id);

  db.prepare(
    `UPDATE approvals SET status=?, resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       resolved_by=?, decision=?, feedback=? WHERE id=?`,
  ).run(args.decision, args.by, args.decision, args.feedback ?? null, args.approvalId);

  if (args.decision === "APPROVED") {
    logEvent(db, "review_approved", agentId, { taskId });
    finalizeCompletion(db, config, taskId, agentId, /* resultId unused */ 0);
    return { taskCompleted: true, reworked: false };
  }

  logEvent(db, "review_rejected", agentId, { taskId, feedback: args.feedback });
  db.prepare(
    "UPDATE agent_results SET review_status='REJECTED', review_feedback=? WHERE id = (SELECT MAX(id) FROM agent_results WHERE task_id=?)",
  ).run(args.feedback ?? null, taskId);
  db.prepare(
    "UPDATE initiative_tasks SET status='READY', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
  ).run(taskId);
  setAgentStatus(db, agentId, "IDLE");
  return { taskCompleted: false, reworked: true };
}

export function requestApproval(
  db: DatabaseSync,
  args: {
    taskId?: number;
    initiativeId?: string;
    agentId?: string;
    type?: "CONTENT" | "DESIGN" | "MESSAGE" | "CAMPAIGN" | "CODE" | "EXTERNAL_ACTION" | "OTHER";
    reason: string;
    payload?: Record<string, unknown>;
  },
): number {
  const inserted = db
    .prepare(
      `INSERT INTO approvals (task_id, initiative_id, agent_id, type, payload, reason)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      args.taskId ?? null,
      args.initiativeId ?? null,
      args.agentId ?? null,
      args.type ?? "OTHER",
      JSON.stringify(args.payload ?? {}),
      args.reason,
    );
  logEvent(db, "approval_requested", args.agentId ?? "system", {
    taskId: args.taskId,
    type: args.type ?? "OTHER",
  });
  return Number(inserted.lastInsertRowid);
}

export function resolveApproval(
  db: DatabaseSync,
  approvalId: number,
  args: { decision: "APPROVED" | "REJECTED"; by: string; feedback?: string },
): void {
  const result = db
    .prepare(
      `UPDATE approvals SET status=?, resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         resolved_by=?, decision=?, feedback=?
       WHERE id=? AND status='PENDING'`,
    )
    .run(args.decision, args.by, args.decision, args.feedback ?? null, approvalId);
  if (Number(result.changes) === 0) {
    throw new NotFoundError(`pending approval not found: ${approvalId}`);
  }
  const evType = args.decision === "APPROVED" ? "approval_approved" : "approval_rejected";
  logEvent(db, evType, null, { approvalId });
}

export function listPendingApprovals(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare("SELECT * FROM approvals WHERE status = 'PENDING' ORDER BY created_at")
    .all() as unknown as Array<Record<string, unknown>>;
}

export interface HandoffInput {
  fromAgent: string;
  toAgent: string;
  taskId?: number;
  initiativeId?: string;
  summary: string;
  payload?: Record<string, unknown>;
  sources?: string[];
  confidence?: number;
}

export function createHandoff(db: DatabaseSync, input: HandoffInput): number {
  const inserted = db
    .prepare(
      `INSERT INTO handoffs (from_agent, to_agent, task_id, initiative_id, summary, payload, sources, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.fromAgent,
      input.toAgent,
      input.taskId ?? null,
      input.initiativeId ?? null,
      input.summary,
      JSON.stringify(input.payload ?? {}),
      JSON.stringify(input.sources ?? []),
      input.confidence ?? 0.8,
    );
  const id = Number(inserted.lastInsertRowid);
  logEvent(db, "handoff_created", input.fromAgent, { handoffId: id, to: input.toAgent });
  sendMessage(db, {
    fromAgent: input.fromAgent,
    toAgent: input.toAgent,
    type: "HANDOFF",
    subject: input.summary.slice(0, 80),
    message: input.summary,
    taskId: input.taskId,
    initiativeId: input.initiativeId,
    attachments: input.payload ? Object.keys(input.payload) : [],
  });
  return id;
}

export function acceptHandoff(db: DatabaseSync, handoffId: number, by: string): void {
  db.prepare("UPDATE handoffs SET status='ACCEPTED' WHERE id=?").run(handoffId);
  logEvent(db, "handoff_accepted", by, { handoffId });
}

export function completeHandoff(
  db: DatabaseSync,
  handoffId: number,
  output: Record<string, unknown>,
): void {
  db.prepare("UPDATE handoffs SET status='COMPLETED', payload=? WHERE id=?").run(
    JSON.stringify(output),
    handoffId,
  );
  logEvent(db, "handoff_completed", null, { handoffId });
}

export function sendMessage(
  db: DatabaseSync,
  input: {
    fromAgent: string;
    toAgent: string;
    type: "REQUEST" | "RESULT" | "QUESTION" | "HANDOFF" | "BLOCKER" | "STATUS" | "REVIEW";
    subject?: string;
    message?: string;
    contextData?: Record<string, unknown>;
    attachments?: string[];
    taskId?: number;
    initiativeId?: string;
  },
): number {
  const inserted = db
    .prepare(
      `INSERT INTO agent_messages (from_agent, to_agent, type, subject, context_data, message, attachments, task_id, initiative_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.fromAgent,
      input.toAgent,
      input.type,
      input.subject ?? "",
      JSON.stringify(input.contextData ?? {}),
      input.message ?? "",
      JSON.stringify(input.attachments ?? []),
      input.taskId ?? null,
      input.initiativeId ?? null,
    );
  return Number(inserted.lastInsertRowid);
}

export function reportOutcome(
  db: DatabaseSync,
  goalId: string,
  delta: number,
): { currentValue: number | null; progressPct: number | null } {
  const goal = updateGoal(db, goalId, {
    currentValue: undefined,
  });
  void goal;
  db.prepare(
    "UPDATE goals SET current_value = COALESCE(current_value,0) + ? WHERE id = ?",
  ).run(delta, goalId);
  addObservation(db, {
    type: "METRIC_CHANGE",
    source: "initiative-result",
    projectId: goalId,
    entityId: goalId,
    data: { delta },
  });
  const row = db
    .prepare("SELECT current_value, target FROM goals WHERE id = ?")
    .get(goalId) as { current_value: number | null; target: number | null };
  const pct =
    row.target && row.current_value !== null
      ? Math.max(0, Math.min(100, Math.round((row.current_value / row.target) * 100)))
      : null;
  return { currentValue: row.current_value, progressPct: pct };
}

export function agentPerformance(
  db: DatabaseSync,
  agentId: string,
): {
  tasksCompleted: number;
  tasksFailed: number;
  averageDurationMs: number | null;
  reworkCount: number;
  blockedCount: number;
} {
  const completed = (
    db.prepare("SELECT COUNT(*) AS c FROM agent_results WHERE agent_id=? AND status='VALID'").get(agentId) as { c: number }
  ).c;
  const failed = (
    db.prepare("SELECT COUNT(*) AS c FROM agent_results WHERE agent_id=? AND status!='VALID'").get(agentId) as { c: number }
  ).c;
  const dur = db
    .prepare(
      `SELECT AVG(julianday(ended_at)-julianday(started_at))*86400000 AS avg_ms
       FROM work_sessions WHERE agent_id=? AND ended_at IS NOT NULL`,
    )
    .get(agentId) as { avg_ms: number | null };
  const rework = (
    db.prepare("SELECT COALESCE(SUM(rework_count),0) AS c FROM agent_results WHERE agent_id=?").get(agentId) as { c: number }
  ).c;
  const blocked = (
    db.prepare("SELECT COUNT(*) AS c FROM agent_messages WHERE from_agent=? AND type='BLOCKER'").get(agentId) as { c: number }
  ).c;

  return {
    tasksCompleted: completed,
    tasksFailed: failed,
    averageDurationMs: dur?.avg_ms != null ? Math.round(dur.avg_ms) : null,
    reworkCount: rework,
    blockedCount: blocked,
  };
}

export function activityLog(
  db: DatabaseSync,
  filters: { initiativeId?: string; limit?: number } = {},
): Array<{ at: string; type: string; subject: string | null }> {
  const limit = Math.max(1, Math.min(500, filters.limit ?? 50));
  const rows = db
    .prepare(
      `SELECT occurred_at AS at, event_type AS type, subject AS subject
       FROM events
       WHERE event_type LIKE 'agent_%' OR event_type LIKE 'task_%'
          OR event_type LIKE 'handoff_%' OR event_type LIKE 'review_%'
          OR event_type LIKE 'approval_%' OR event_type LIKE '%goal%'
       ORDER BY id DESC LIMIT ?`,
    )
    .all(limit) as unknown as Array<{ at: string; type: string; subject: string | null }>;
  return rows;
}
