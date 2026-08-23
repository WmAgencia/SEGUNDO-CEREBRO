import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { NotFoundError, ValidationError } from "../errors/errors.ts";

export const GOAL_TYPES = [
  "BUSINESS", "PROJECT", "FINANCIAL", "MARKETING",
  "SALES", "PRODUCT", "PERSONAL", "OPERATIONAL",
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

export const GOAL_STATUSES = [
  "DRAFT", "ACTIVE", "PAUSED", "ACHIEVED", "FAILED", "CANCELLED", "ARCHIVED",
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export interface GoalRecord {
  id: string;
  name: string;
  description: string;
  type: string;
  status: string;
  priority: number;
  ownerAgent: string | null;
  parentGoalId: string | null;
  metricName: string | null;
  target: number | null;
  currentValue: number | null;
  deadline: string | null;
  project: string | null;
  constraints: string[];
  progressPct: number | null;
  createdAt: string;
  updatedAt: string;
}

interface RawGoal {
  id: string;
  name: string;
  description: string;
  type: string;
  status: string;
  priority: number;
  owner_agent: string | null;
  parent_goal_id: string | null;
  metric_name: string | null;
  target: number | null;
  current_value: number | null;
  deadline: string | null;
  constraints_json: string;
  project: string | null;
  created_at: string;
  updated_at: string;
}

function toGoal(r: RawGoal): GoalRecord {
  let constraints: unknown[] = [];
  try {
    const p = JSON.parse(r.constraints_json ?? "[]");
    if (Array.isArray(p)) constraints = p;
  } catch {}
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    type: r.type,
    status: r.status,
    priority: r.priority,
    ownerAgent: r.owner_agent,
    parentGoalId: r.parent_goal_id,
    project: r.project ?? null,
    metricName: r.metric_name,
    target: r.target,
    currentValue: r.current_value,
    deadline: r.deadline,
    constraints: constraints.filter((c): c is string => typeof c === "string"),
    progressPct: goalProgress(r),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function goalProgress(r: {
  target: number | null;
  current_value: number | null;
}): number | null {
  if (r.target === null || r.current_value === null || r.target === 0) return null;
  return Math.max(0, Math.min(100, Math.round((r.current_value / r.target) * 100)));
}

function slugId(name: string, type: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hash = createHash("sha256").update(name).digest("hex").slice(0, 6);
  return `goal.${type.toLowerCase()}.${slug || hash}.${hash}`;
}

export interface CreateGoalInput {
  name: string;
  description?: string;
  type?: GoalType;
  status?: GoalStatus;
  priority?: number;
  ownerAgent?: string;
  parentGoalId?: string;
  metricName?: string;
  target?: number;
  currentValue?: number;
  deadline?: string;
  constraints?: string[];
  projectId?: string;
}

const SOURCE_ID = "src.system";

export function createGoal(db: DatabaseSync, input: CreateGoalInput): GoalRecord {
  if (!input.name || input.name.trim() === "") {
    throw new ValidationError("goal name is required");
  }
  db.prepare(
    `INSERT INTO sources (id, source_type, location) VALUES ('src.system', 'system', 'goals')
     ON CONFLICT(id) DO NOTHING`,
  ).run();

  const type = (input.type ?? "PROJECT").toUpperCase();
  const id = slugId(input.name, type);

  db.prepare(
    `INSERT INTO goals (id, name, description, type, status, priority, owner_agent,
       parent_goal_id, project, metric_name, target, current_value, deadline, constraints_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(
    id,
    input.name.trim(),
    input.description ?? "",
    type,
    input.status ?? "ACTIVE",
    input.priority ?? 3,
    input.ownerAgent ?? null,
    input.parentGoalId ?? null,
    input.projectId ?? null,
    input.metricName ?? null,
    input.target ?? null,
    input.currentValue ?? null,
    input.deadline ?? null,
    JSON.stringify(input.constraints ?? []),
  );

  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('goal_created', ?, ?)`,
  ).run(id, JSON.stringify({ type, metric: input.metricName ?? null }));

  return getGoal(db, id);
}

export function getGoal(db: DatabaseSync, id: string): GoalRecord {
  const row = db.prepare("SELECT * FROM goals WHERE id = ?").get(id) as
    | RawGoal
    | undefined;
  if (!row) throw new NotFoundError(`goal not found: ${id}`);
  return toGoal(row);
}

export function updateGoal(
  db: DatabaseSync,
  id: string,
  patch: Partial<CreateGoalInput> & { currentValue?: number; status?: GoalStatus },
): GoalRecord {
  const existing = getGoal(db, id);
  const next = {
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    type: (patch.type ?? existing.type).toUpperCase(),
    status: (patch.status ?? existing.status).toUpperCase(),
    priority: patch.priority ?? existing.priority,
    ownerAgent: patch.ownerAgent ?? existing.ownerAgent,
    parentGoalId: patch.parentGoalId ?? existing.parentGoalId,
    metricName: patch.metricName ?? existing.metricName,
    target: patch.target ?? existing.target,
    currentValue: patch.currentValue ?? existing.currentValue,
    deadline: patch.deadline ?? existing.deadline,
  };
  db.prepare(
    `UPDATE goals SET name=?, description=?, type=?, status=?, priority=?, owner_agent=?,
       parent_goal_id=?, metric_name=?, target=?, current_value=?, deadline=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=?`,
  ).run(
    next.name, next.description, next.type, next.status, next.priority,
    next.ownerAgent, next.parentGoalId, next.metricName,
    next.target, next.currentValue, next.deadline, id,
  );
  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('goal_updated', ?, ?)`,
  ).run(id, JSON.stringify({ status: next.status, currentValue: next.currentValue }));
  return getGoal(db, id);
}

export function listGoals(
  db: DatabaseSync,
  filters: { status?: string; type?: string } = {},
): GoalRecord[] {
  const where: string[] = [];
  const values: string[] = [];
  if (filters.status) {
    where.push("status = ?");
    values.push(filters.status.toUpperCase());
  }
  if (filters.type) {
    where.push("type = ?");
    values.push(filters.type.toUpperCase());
  }
  const rows = db
    .prepare(
      `SELECT * FROM goals ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY priority ASC, deadline IS NULL, deadline ASC`,
    )
    .all(...values) as unknown as RawGoal[];
  return rows.map(toGoal);
}

export function listActiveGoalsByPriority(db: DatabaseSync, limit = 5): Array<
  GoalRecord & { score: number; reasons: string[] }
> {
  const active = listGoals(db, { status: "ACTIVE" });
  return active
    .map((g) => ({ ...g, ...goalPriority(g) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

export function goalPriority(goal: GoalRecord): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  let score = 50;

  const prioBoost = (4 - Math.min(5, Math.max(1, goal.priority))) * 6;
  if (prioBoost !== 0) {
    score += prioBoost;
    reasons.push(`prioridade declarada ${goal.priority} (${prioBoost >= 0 ? "+" : ""}${Math.round(prioBoost)})`);
  }

  if (goal.deadline) {
    const days = Math.ceil((Date.parse(goal.deadline) - Date.now()) / 86400000);
    if (Number.isFinite(days)) {
      if (days <= 7) {
        score += 20;
        reasons.push(`prazo em ${Math.max(days, 0)} dias (+20 urgência)`);
      } else if (days <= 30) {
        score += 10;
        reasons.push(`prazo em ${days} dias (+10)`);
      } else {
        score += 4;
        reasons.push(`prazo em ${days} dias (+4)`);
      }
      if (days < 0) {
        score -= 15;
        reasons.push("prazo vencido (-15)");
      }
    }
  }

  if (goal.progressPct !== null && goal.progressPct > 0) {
    score += Math.min(10, Math.round(goal.progressPct / 10));
    reasons.push(`${goal.progressPct}% de progresso já alcançado`);
  }

  if (goal.project) {
    score += 5;
    reasons.push("vinculado a projeto/entidade (+5 alinhamento)");
  }

  if (goal.parentGoalId) {
    score += 5;
    reasons.push("subobjetivo de meta maior (+5)");
  }

  return { score: Math.round(score), reasons };
}

declare module "./goal-engine.ts" {}
