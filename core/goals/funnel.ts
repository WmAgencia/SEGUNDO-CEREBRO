import { DatabaseSync } from "node:sqlite";
import { NotFoundError, ValidationError } from "../errors/errors.ts";

export const OBSERVATION_TYPES = [
  "METRIC_CHANGE", "NEW_INFORMATION", "PROBLEM", "OPPORTUNITY_SIGNAL",
  "DEADLINE", "PATTERN", "ANOMALY", "USER_SIGNAL",
] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export interface GoalObservation {
  id: number;
  obsType: string;
  source: string;
  projectId: string | null;
  entityId: string | null;
  data: Record<string, unknown>;
  confidence: number;
  importance: number;
  createdAt: string;
}

interface RawObservation {
  id: number;
  obs_type: string;
  source: string;
  project: string | null;
  entity_id: string | null;
  data: string;
  confidence: number;
  importance: number;
  created_at: string;
}

export function addObservation(
  db: DatabaseSync,
  input: {
    type: ObservationType;
    source?: string;
    projectId?: string;
    entityId?: string;
    data?: Record<string, unknown>;
    confidence?: number;
    importance?: number;
  },
): GoalObservation {
  if (!OBSERVATION_TYPES.includes(input.type)) {
    throw new ValidationError(`invalid observation type`, {
      allowed: OBSERVATION_TYPES,
    });
  }
  const inserted = db
    .prepare(
      `INSERT INTO goal_observations (obs_type, source, project, entity_id, data, confidence, importance)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.type,
      input.source ?? "system",
      input.projectId ?? null,
      input.entityId ?? null,
      JSON.stringify(input.data ?? {}),
      input.confidence ?? 0.7,
      input.importance ?? 0.5,
    );
  const row = db
    .prepare("SELECT * FROM goal_observations WHERE id = ?")
    .get(Number(inserted.lastInsertRowid)) as unknown as RawObservation;

  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('observation_created', ?, ?)`,
  ).run(input.projectId ?? input.entityId ?? null, JSON.stringify({ type: input.type }));

  return {
    id: row.id,
    obsType: row.obs_type,
    source: row.source,
    projectId: row.project,
    entityId: row.entity_id,
    data: safeParse(row.data),
    confidence: row.confidence,
    importance: row.importance,
    createdAt: row.created_at,
  };
}

export function listObservations(
  db: DatabaseSync,
  filters: { type?: ObservationType; projectId?: string; limit?: number } = {},
): GoalObservation[] {
  const where: string[] = [];
  const values: string[] = [];
  if (filters.type) {
    where.push("obs_type = ?");
    values.push(filters.type);
  }
  if (filters.projectId) {
    where.push("project = ?");
    values.push(filters.projectId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM goal_observations ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...values, String(Math.max(1, Math.min(200, filters.limit ?? 50)))) as unknown as RawObservation[];
  return rows.map((row) => ({
    id: row.id,
    obsType: row.obs_type,
    source: row.source,
    projectId: row.project,
    entityId: row.entity_id,
    data: safeParse(row.data),
    confidence: row.confidence,
    importance: row.importance,
    createdAt: row.created_at,
  }));
}

export const OPPORTUNITY_STATUSES = [
  "NEW", "ANALYZING", "PROPOSED", "ACCEPTED", "REJECTED", "EXPIRED", "CONVERTED",
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export interface Opportunity {
  id: number;
  title: string;
  description: string;
  sourceObservationId: number | null;
  goalId: string | null;
  project: string | null;
  potentialImpact: number | null;
  estimatedEffort: number | null;
  risk: number | null;
  confidence: number;
  status: string;
}

export interface CreateOpportunityInput {
  title: string;
  description?: string;
  sourceObservationId?: number;
  goalId?: string;
  project?: string;
  potentialImpact?: number;
  estimatedEffort?: number;
  risk?: number;
  confidence?: number;
  status?: OpportunityStatus;
}

export function createOpportunity(
  db: DatabaseSync,
  input: CreateOpportunityInput,
): Opportunity {
  if (!input.title || input.title.trim() === "") {
    throw new ValidationError("opportunity title is required");
  }
  if (
    input.sourceObservationId !== undefined &&
    !db.prepare("SELECT id FROM goal_observations WHERE id = ?").get(input.sourceObservationId)
  ) {
    throw new ValidationError("source observation not found");
  }
  const inserted = db
    .prepare(
      `INSERT INTO opportunities (title, description, source_observation, goal_id, project, potential_impact, estimated_effort, risk, confidence, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.title.trim(),
      input.description ?? "",
      input.sourceObservationId ?? null,
      input.goalId ?? null,
      input.project ?? null,
      input.potentialImpact ?? null,
      input.estimatedEffort ?? null,
      input.risk ?? null,
      input.confidence ?? 0.6,
      input.status ?? "NEW",
    );
  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('opportunity_detected', ?, ?)`,
  ).run(input.project ?? null, JSON.stringify({ title: input.title }));

  return getOpportunity(db, Number(inserted.lastInsertRowid));
}

export function getOpportunity(db: DatabaseSync, id: number): Opportunity {
  const row = db.prepare("SELECT * FROM opportunities WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFoundError(`opportunity not found: ${id}`);
  return mapOpportunity(row);
}

function mapOpportunity(row: Record<string, unknown>): Opportunity {
  return {
    id: Number(row.id),
    title: String(row.title),
    description: String(row.description ?? ""),
    sourceObservationId:
      row.source_observation === null || row.source_observation === undefined
        ? null
        : Number(row.source_observation),
    goalId: (row.goal_id as string | null) ?? null,
    project: (row.project as string | null) ?? null,
    potentialImpact: (row.potential_impact as number | null) ?? null,
    estimatedEffort: (row.estimated_effort as number | null) ?? null,
    risk: (row.risk as number | null) ?? null,
    confidence: Number(row.confidence ?? 0.6),
    status: String(row.status),
  };
}

export function listOpportunities(
  db: DatabaseSync,
  filters: { status?: OpportunityStatus; projectId?: string; limit?: number } = {},
): Opportunity[] {
  const where: string[] = [];
  const values: Array<string | number> = [];
  if (filters.status) {
    where.push("status = ?");
    values.push(filters.status);
  }
  if (filters.projectId) {
    where.push("project = ?");
    values.push(filters.projectId);
  }
  const rows = db
    .prepare(
      `SELECT * FROM opportunities ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY created_at DESC LIMIT ?`,
    )
    .all(...values, String(Math.max(1, Math.min(100, filters.limit ?? 20))));
  return (rows as unknown as Array<Record<string, unknown>>).map(mapOpportunity);
}

export interface Hypothesis {
  id: number;
  opportunityId: number | null;
  statement: string;
  evidence: string[];
  confidence: number;
  expectedOutcome: string | null;
  metricName: string | null;
  validationMethod: string | null;
}

export interface CreateHypothesisInput {
  opportunityId?: number;
  statement: string;
  evidence?: string[];
  confidence?: number;
  expectedOutcome?: string;
  metricName?: string;
  validationMethod?: string;
}

export function createHypothesis(
  db: DatabaseSync,
  input: CreateHypothesisInput,
): Hypothesis {
  if (!input.statement || input.statement.trim() === "") {
    throw new ValidationError("hypothesis statement is required");
  }
  if (input.statement.toLowerCase().startsWith("fato:") || input.statement.toLowerCase().startsWith("fact:")) {
    throw new ValidationError("hipótese não pode ser registrada como fato");
  }
  const inserted = db
    .prepare(
      `INSERT INTO hypotheses (opportunity_id, statement, evidence_json, confidence, expected_outcome, metric_name, validation_method)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.opportunityId ?? null,
      input.statement.trim(),
      JSON.stringify(input.evidence ?? []),
      input.confidence ?? 0.5,
      input.expectedOutcome ?? null,
      input.metricName ?? null,
      input.validationMethod ?? null,
    );
  const id = Number(inserted.lastInsertRowid);
  return getHypothesis(db, id);
}

export function getHypothesis(db: DatabaseSync, id: number): Hypothesis {
  const row = db.prepare("SELECT * FROM hypotheses WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFoundError(`hypothesis not found: ${id}`);
  let evidence: string[] = [];
  try {
    const p: unknown = JSON.parse(String(row.evidence_json ?? "[]"));
    if (Array.isArray(p)) evidence = p.filter((e): e is string => typeof e === "string");
  } catch {}
  return {
    id: Number(row.id),
    opportunityId:
      row.opportunity_id === null || row.opportunity_id === undefined
        ? null
        : Number(row.opportunity_id),
    statement: String(row.statement),
    evidence: evidence.filter((e): e is string => typeof e === "string"),
    confidence: Number(row.confidence ?? 0.5),
    expectedOutcome: (row.expected_outcome as string | null) ?? null,
    metricName: (row.metric_name as string | null) ?? null,
    validationMethod: (row.validation_method as string | null) ?? null,
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
