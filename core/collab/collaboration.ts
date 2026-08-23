import { DatabaseSync } from "node:sqlite";
import { ValidationError, NotFoundError } from "../errors/errors.ts";

function logEvent(
  db: DatabaseSync,
  eventType: string,
  subject: string | null,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    "INSERT INTO events (event_type, subject, payload) VALUES (?, ?, ?)",
  ).run(eventType, subject, JSON.stringify(payload));
}

export const COLLAB_TYPES = [
  "QUESTION", "ANSWER", "PROPOSAL", "COUNTERARGUMENT",
  "REVIEW", "EVIDENCE", "DECISION_REQUEST", "DECISION", "BLOCKER",
] as const;
export type CollabType = (typeof COLLAB_TYPES)[number];

export interface CollabSession {
  id: number;
  topic: string;
  objective: string;
  participants: string[];
  maxRounds: number;
  maxExternal: number;
  round: number;
  status: string;
}

export function startCollaboration(
  db: DatabaseSync,
  input: {
    topic: string;
    objective?: string;
    participants?: string[];
    initiativeId?: string;
    taskId?: number;
    maxRounds?: number;
    maxExternal?: number;
  },
): CollabSession {
  if (!input.topic || input.topic.trim() === "") {
    throw new ValidationError("collaboration topic is required");
  }
  const inserted = db
    .prepare(
      `INSERT INTO collab_sessions (topic, objective, initiative_id, task_id, participants, max_rounds, max_external, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')`,
    )
    .run(
      input.topic,
      input.objective ?? "",
      input.initiativeId ?? null,
      input.taskId ?? null,
      JSON.stringify(input.participants ?? []),
      Math.max(1, Math.min(10, input.maxRounds ?? 3)),
      Math.max(0, Math.min(10, input.maxExternal ?? 2)),
    );
  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('collaboration_started', NULL, ?)`,
  ).run(JSON.stringify({ sessionId: Number(inserted.lastInsertRowid), topic: input.topic }));
  return getCollaboration(db, Number(inserted.lastInsertRowid));
}

export function getCollaboration(db: DatabaseSync, id: number): CollabSession {
  const row = db.prepare("SELECT * FROM collab_sessions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFoundError(`collaboration session not found: ${id}`);
  return mapSession(row);
}

function mapSession(row: Record<string, unknown>): CollabSession {
  let participants: unknown = [];
  try {
    const p = JSON.parse(String(row.participants ?? "[]"));
    if (Array.isArray(p)) participants = p;
  } catch {}
  return {
    id: Number(row.id),
    topic: String(row.topic),
    objective: String(row.objective ?? ""),
    participants: participants as string[],
    maxRounds: Number(row.max_rounds ?? 3),
    maxExternal: Number(row.max_external ?? 2),
    round: Number(row.round ?? 0),
    status: String(row.status),
  };
}

export function postCollaborationMessage(
  db: DatabaseSync,
  input: {
    sessionId: number;
    fromParticipant: string;
    toParticipant?: string;
    type: CollabType;
    content?: Record<string, unknown>;
  },
): { messageId: number; sessionRound: number; limitReached: boolean } {
  const session = db
    .prepare("SELECT * FROM collab_sessions WHERE id = ?")
    .get(input.sessionId) as Record<string, unknown> | undefined;
  if (!session) throw new NotFoundError(`session not found: ${input.sessionId}`);

  const currentStatus = String(session.status);
  if (["RESOLVED", "CANCELLED"].includes(currentStatus)) {
    throw new ValidationError(`session is ${currentStatus}`);
  }

  let round = Number(session.round ?? 0);
  let limitReached = false;

  if (input.type === "COUNTERARGUMENT" || input.type === "PROPOSAL") {
    round += 1;
    if (round > Number(session.max_rounds)) {
      throw new ValidationError(
        `colaboração atingiu o limite de ${session.max_rounds} rounds`,
      );
    }
    db.prepare("UPDATE collab_sessions SET round = ? WHERE id = ?").run(round, input.sessionId);
    if (round === session.max_rounds) limitReached = true;
  }

  const redactedContent = redactJson(input.content ?? {});
  const inserted = db
    .prepare(
      `INSERT INTO collab_messages (session_id, from_p, to_p, type, content)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId,
      input.fromParticipant,
      input.toParticipant ?? null,
      input.type,
      JSON.stringify(redactedContent),
    );
  logEvent(db, "collaboration_message", input.fromParticipant, {
    sessionId: input.sessionId,
    type: input.type,
  });

  return { messageId: Number(inserted.lastInsertRowid), sessionRound: round, limitReached };
}

function redactJson(value: Record<string, unknown>): Record<string, unknown> {
  const str = JSON.stringify(value).replace(
    /(gsk_|sk-)[A-Za-z0-9]{10,}/g,
    "[REDACTED]",
  );
  return JSON.parse(str) as Record<string, unknown>;
}

export function listCollaborationMessages(
  db: DatabaseSync,
  sessionId: number,
): Array<{ id: number; fromP: string; toP: string | null; type: string; content: Record<string, unknown>; createdAt: string }> {
  const rows = db
    .prepare("SELECT * FROM collab_messages WHERE session_id = ? ORDER BY created_at ASC")
    .all(sessionId) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id),
    fromP: String(row.from_p),
    toP: row.to_p ? String(row.to_p) : null,
    type: String(row.type),
    content: safeParse(String(row.content)),
    createdAt: String(row.created_at),
  }));
}

export function resolveCollaboration(
  db: DatabaseSync,
  sessionId: number,
  decisionId?: number,
): void {
  db.prepare(
    "UPDATE collab_sessions SET status='RESOLVED', ended_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), decision_id=? WHERE id=?",
  ).run(decisionId ?? null, sessionId);
  logEvent(db, "collaboration_completed", null, { sessionId });
}

export interface DecisionRecord {
  id: number;
  sessionId: number | null;
  question: string;
  selectedOption: string | null;
  reasons: string[];
  decidedBy: string;
  humanOverride: string | null;
  confidence: number;
}

export function createDecision(
  db: DatabaseSync,
  input: {
    sessionId?: number;
    initiativeId?: string;
    question: string;
    options?: string[];
    selectedOption?: string;
    participants?: string[];
    evidence?: string[];
    reasons?: string[];
    confidence?: number;
    decidedBy?: string;
  },
): DecisionRecord {
  if (!input.question.trim()) throw new ValidationError("decision question is required");
  const inserted = db
    .prepare(
      `INSERT INTO decisions (session_id, initiative_id, question, options, selected_option, participants, evidence, reasons, confidence, decided_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.sessionId ?? null,
      input.initiativeId ?? null,
      input.question,
      JSON.stringify(input.options ?? []),
      input.selectedOption ?? null,
      JSON.stringify(input.participants ?? []),
      JSON.stringify(input.evidence ?? []),
      JSON.stringify(input.reasons ?? ["decisão baseada no contexto disponível"]),
      input.confidence ?? 0.7,
      input.decidedBy ?? "orchestrator",
    );

  if (input.sessionId) {
    db.prepare("UPDATE collab_sessions SET status='RESOLVED', decision_id=? WHERE id=? AND status='ACTIVE'").run(
      Number(inserted.lastInsertRowid),
      input.sessionId,
    );
  }
  logEvent(db, "decision_created", null, {
    decisionId: Number(inserted.lastInsertRowid),
    question: input.question.slice(0, 80),
  });

  return getDecision(db, Number(inserted.lastInsertRowid));
}

export function overrideDecision(
  db: DatabaseSync,
  decisionId: number,
  args: { by: string; reason: string; newSelectedOption?: string },
): DecisionRecord {
  db.prepare(
    `UPDATE decisions SET human_override=?, status='OVERRIDDEN'
     WHERE id=?`,
  ).run(JSON.stringify({ by: args.by, reason: args.reason }), decisionId);

  if (args.newSelectedOption) {
    db.prepare("UPDATE decisions SET selected_option=? WHERE id=?").run(args.newSelectedOption, decisionId);
  }
  logEvent(db, "decision_overridden", args.by, { decisionId, reason: args.reason });
  return getDecision(db, decisionId);
}

export function getDecision(db: DatabaseSync, id: number): DecisionRecord {
  const row = db.prepare("SELECT * FROM decisions WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFoundError(`decision not found: ${id}`);
  return mapDecision(row);
}

function mapDecision(row: Record<string, unknown>): DecisionRecord {
  return {
    id: Number(row.id),
    sessionId: row.session_id ? Number(row.session_id) : null,
    question: String(row.question),
    selectedOption: row.selected_option ? String(row.selected_option) : null,
    reasons: parseArr(String(row.reasons)),
    decidedBy: String(row.decided_by ?? ""),
    humanOverride: row.human_override ? String(row.human_override) : null,
    confidence: Number(row.confidence ?? 0.7),
  };
}

function parseArr(raw: string): string[] {
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const p = JSON.parse(raw);
    return p && typeof p === "object" && !Array.isArray(p)
      ? (p as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
