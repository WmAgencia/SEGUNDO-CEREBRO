import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";

export interface Observation {
  id: number;
  patternKey: string;
  observationType: string;
  subject: string | null;
  payload: Record<string, unknown>;
  count: number;
  status: "observation" | "candidate" | "accepted" | "rejected";
}

interface RawObservation {
  id: number;
  pattern_key: string;
  observation_type: string;
  subject: string | null;
  payload: string;
  count: number;
  status: string;
}

export const LEARNING_THRESHOLD_DEFAULT = 3;

function normalizePattern(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function observe(
  db: DatabaseSync,
  input: {
    observationType: string;
    subject: string;
    patternKey?: string;
    payload?: Record<string, unknown>;
    threshold?: number;
  },
): Observation & { isCandidate: boolean } {
  if (!input.observationType.trim() || !input.subject.trim()) {
    throw new ValidationError("observationType and subject are required");
  }
  const patternKey =
    input.patternKey ??
    normalizePattern(`${input.observationType} ${input.subject}`).slice(0, 120);
  const threshold = Math.max(1, input.threshold ?? LEARNING_THRESHOLD_DEFAULT);

  db.prepare(
    `INSERT INTO observations (pattern_key, observation_type, subject, payload)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(pattern_key, observation_type) DO UPDATE SET
       count = count + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).run(
    patternKey,
    input.observationType,
    input.subject,
    JSON.stringify(input.payload ?? {}),
  );

  const row = db
    .prepare(
      "SELECT * FROM observations WHERE pattern_key = ? AND observation_type = ?",
    )
    .get(patternKey, input.observationType) as RawObservation | undefined;
  if (!row) throw new Error("observation upsert failed");

  let status = row.status as Observation["status"];
  let isCandidate = false;
  if (
    status === "observation" &&
    row.count >= threshold
  ) {
    db.prepare("UPDATE observations SET status = 'candidate' WHERE id = ?").run(row.id);
    status = "candidate";
    isCandidate = true;
  }

  return {
    id: row.id,
    patternKey: row.pattern_key,
    observationType: row.observation_type,
    subject: row.subject,
    payload: safeParse(row.payload),
    count: row.count,
    status,
    isCandidate,
  };
}

export function listCandidates(db: DatabaseSync): Observation[] {
  return (db
    .prepare("SELECT * FROM observations WHERE status IN ('observation','candidate') ORDER BY count DESC")
    .all() as unknown as RawObservation[]).map(fromRow);
}

export function acceptObservation(
  db: DatabaseSync,
  id: number,
): Observation {
  return setStatus(db, id, "accepted");
}

export function rejectObservation(
  db: DatabaseSync,
  id: number,
): Observation {
  return setStatus(db, id, "rejected");
}

function setStatus(db: DatabaseSync, id: number, status: string): Observation {
  const result = db
    .prepare(
      "UPDATE observations SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
    )
    .run(status, id);
  if (Number(result.changes) === 0) {
    throw new ValidationError(`observation not found: ${id}`);
  }
  const row = db.prepare("SELECT * FROM observations WHERE id = ?").get(id) as unknown as RawObservation;
  return fromRow(row);
}

function fromRow(r: RawObservation): Observation {
  return {
    id: r.id,
    patternKey: r.pattern_key,
    observationType: r.observation_type,
    subject: r.subject,
    payload: safeParse(r.payload),
    count: r.count,
    status: r.status as Observation["status"],
  };
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
