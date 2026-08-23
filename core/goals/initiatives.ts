import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { NotFoundError, ValidationError } from "../errors/errors.ts";
import type { BrainConfig } from "../config/loader.ts";
import { getGoal } from "./goal-engine.ts";
import { searchSkills } from "../skills/skill-engine.ts";
import { resolveTools } from "../tools/tool-registry.ts";
import { listAgents } from "../agents/agent-runtime.ts";

export const INITIATIVE_STATUSES = [
  "DRAFT", "PROPOSED", "AWAITING_APPROVAL", "APPROVED", "REJECTED",
  "RUNNING", "PAUSED", "COMPLETED", "FAILED", "CANCELLED",
] as const;
export type InitiativeStatus = (typeof INITIATIVE_STATUSES)[number];

export interface InitiativeRecord {
  id: string;
  title: string;
  description: string;
  goalId: string | null;
  project: string | null;
  hypothesisId: number | null;
  ownerAgent: string | null;
  supportAgents: string[];
  requiredSkills: string[];
  requiredTools: string[];
  estimatedCost: number | null;
  effort: number | null;
  impact: number | null;
  probability: number | null;
  risk: number | null;
  expectedOutcome: string | null;
  status: string;
  approvalStatus: string;
  approvedBy: string | null;
  rejectionReason: string | null;
}

interface RawInitiative {
  id: string;
  title: string;
  description: string;
  goal_id: string | null;
  project: string | null;
  hypothesis_id: number | null;
  owner_agent: string | null;
  support_agents: string;
  required_skills: string;
  required_tools: string;
  estimated_cost: number | null;
  effort: number | null;
  impact: number | null;
  probability: number | null;
  risk: number | null;
  expected_outcome: string | null;
  status: string;
  approval_status: string;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toInitiative(r: RawInitiative): InitiativeRecord {
  const list = (raw: string): string[] => {
    try {
      const p = JSON.parse(raw);
      return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
    } catch {
      return [];
    }
  };
  return {
    id: r.id,
    title: r.title,
    description: r.description,
    goalId: r.goal_id,
    project: r.project,
    hypothesisId: r.hypothesis_id,
    ownerAgent: r.owner_agent,
    supportAgents: list(r.support_agents),
    requiredSkills: list(r.required_skills),
    requiredTools: list(r.required_tools),
    estimatedCost: r.estimated_cost,
    effort: r.effort,
    impact: r.impact,
    probability: r.probability,
    risk: r.risk,
    expectedOutcome: r.expected_outcome,
    status: r.status,
    approvalStatus: r.approval_status,
    approvedBy: r.approved_by,
    rejectionReason: r.rejection_reason,
  };
}

export function createInitiative(
  db: DatabaseSync,
  input: {
    title: string;
    description?: string;
    goalId?: string;
    project?: string;
    hypothesisId?: number;
    estimatedCost?: number;
    effort?: number;
    impact?: number;
    probability?: number;
    risk?: number;
    expectedOutcome?: string;
    status?: InitiativeStatus;
  },
): InitiativeRecord {
  if (!input.title || input.title.trim() === "") {
    throw new ValidationError("initiative title is required");
  }
  const id = `init.${createHash("sha256")
    .update(input.title + Date.now().toString())
    .digest("hex")
    .slice(0, 10)}`;

  db.prepare(
    `INSERT INTO initiatives (id, title, description, goal_id, project, hypothesis_id,
       estimated_cost, effort, impact, probability, risk, expected_outcome, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.title.trim(),
    input.description ?? "",
    input.goalId ?? null,
    input.project ?? null,
    input.hypothesisId ?? null,
    input.estimatedCost ?? null,
    input.effort ?? null,
    input.impact ?? null,
    input.probability ?? null,
    input.risk ?? null,
    input.expectedOutcome ?? null,
    input.status ?? "DRAFT",
  );
  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('initiative_created', ?, ?)`,
  ).run(input.project ?? null, JSON.stringify({ initiativeId: id }));

  return getInitiative(db, id);
}

export function getInitiative(db: DatabaseSync, id: string): InitiativeRecord {
  const row = db.prepare("SELECT * FROM initiatives WHERE id = ?").get(id) as
    | RawInitiative
    | undefined;
  if (!row) throw new NotFoundError(`initiative not found: ${id}`);
  return toInitiative(row);
}

export function listInitiatives(
  db: DatabaseSync,
  filters: { status?: InitiativeStatus; projectId?: string } = {},
): InitiativeRecord[] {
  const where: string[] = [];
  const values: string[] = [];
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
      `SELECT * FROM initiatives ${where.length ? "WHERE " + where.join(" AND ") : ""}
       ORDER BY created_at DESC`,
    )
    .all(...values) as unknown as RawInitiative[];
  return rows.map(toInitiative);
}

export function updateInitiativeStatus(
  db: DatabaseSync,
  id: string,
  status: InitiativeStatus,
): InitiativeRecord {
  db.prepare(
    `UPDATE initiatives SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
  ).run(status, id);
  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('initiative_updated', ?, ?)`,
  ).run(id, JSON.stringify({ status }));
  return getInitiative(db, id);
}

export function approveInitiative(
  db: DatabaseSync,
  id: string,
  approvedBy: string,
): InitiativeRecord {
  db.prepare(
    `UPDATE initiatives SET approval_status='APPROVED', status='APPROVED', approved_by=?,
       approved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=?`,
  ).run(approvedBy, id);
  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('proposal_approved', ?, ?)`,
  ).run(id, JSON.stringify({ approvedBy }));
  return getInitiative(db, id);
}

export function rejectInitiativeApproval(
  db: DatabaseSync,
  id: string,
  reason: string | null,
  rejectedBy: string,
): InitiativeRecord {
  db.prepare(
    `UPDATE initiatives SET approval_status='REJECTED', approved_by=?, rejection_reason=?,
       updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id=?`,
  ).run(rejectedBy, reason, id);
  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('proposal_rejected', ?, ?)`,
  ).run(id, JSON.stringify({ rejectedBy, reason }));
  return getInitiative(db, id);
}

export function scoreInitiative(initiative: InitiativeRecord): {
  score: number;
  reasons: string[];
} {
  const reasons: string[] = [];
  const scale = (v: number | null, fallback: number): number =>
    v === null || !Number.isFinite(v) ? fallback : Math.max(0, Math.min(10, v));

  const impact = scale(initiative.impact, 5);
  const probability = scale(initiative.probability, 5);
  const cost = scale(initiative.estimatedCost === null ? null : Math.min(10, (initiative.estimatedCost ?? 0) / 100), 5);
  const effort = scale(initiative.effort, 5);
  const risk = scale(initiative.risk, 5);

  let score =
    impact * 3 +
    probability * 2 -
    cost * 1.5 -
    effort * 1 -
    risk * 2 +
    30;

  reasons.push(`impacto ${impact}/10 (+${impact * 3})`);
  reasons.push(`probabilidade ${probability}/10 (+${probability * 2})`);
  if (cost !== 5 || initiative.estimatedCost !== null) {
    reasons.push(`custo ${cost}/10 (-${cost * 1.5})`);
  }
  reasons.push(`esforço ${effort}/10 (-${effort})`);
  reasons.push(`risco ${risk}/10 (-${risk * 2})`);

  if (initiative.goalId) {
    score += 8;
    reasons.push("alinhado a um objetivo (+8)");
  }

  score = Math.round(Math.max(0, Math.min(100, score)));
  return { score, reasons };
}

const DEFAULT_SALES_PLAN = [
  "Definir ICP",
  "Pesquisar leads",
  "Qualificar leads",
  "Criar mensagem de abordagem",
  "Preparar campanha",
  "Solicitar aprovação humana",
  "Executar outreach",
  "Acompanhar respostas",
  "Follow-up",
  "Medir resultado",
];

export function planInitiative(
  db: DatabaseSync,
  initiativeId: string,
  tasks?: string[],
): Array<{ ordinal: number; title: string; dependsOn: number | null }> {
  const initiative = getInitiative(db, initiativeId);
  const titles = tasks && tasks.length > 0 ? tasks : DEFAULT_SALES_PLAN;
  const existing = db
    .prepare("SELECT COUNT(*) AS c FROM initiative_tasks WHERE initiative_id = ?")
    .get(initiativeId) as { c: number };
  if ((existing?.c ?? 0) > 0) {
    throw new ValidationError("iniciativa já possui plano");
  }

  const insert = db.prepare(
    `INSERT INTO initiative_tasks (initiative_id, ordinal, title, depends_on)
     VALUES (?, ?, ?, ?)`,
  );
  let prevId: number | null = null;
  const out: Array<{ ordinal: number; title: string; dependsOn: number | null }> = [];
  titles.forEach((title, i) => {
    const res = insert.run(initiativeId, i + 1, title, prevId);
    const taskId = Number(res.lastInsertRowid);
    out.push({ ordinal: i + 1, title, dependsOn: prevId });
    prevId = taskId;
  });
  return out;
}

export function alignInitiative(db: DatabaseSync, config: BrainConfig, initiativeId: string): {
  skills: ReturnType<typeof searchSkills>;
  tools: ReturnType<typeof resolveTools>;
  ownerAgent: string | null;
  supportAgents: string[];
} {
  const initiative = getInitiative(db, initiativeId);
  const haystack = `${initiative.title} ${initiative.description}`;
  const skills = searchSkills(db, haystack);
  const tools = resolveTools(db, haystack, { limit: 5 });

  const agents = listAgents(db).filter((a) => a.status === "active");
  const skillTokens = new Set(
    skills.primary.concat(skills.supporting).flatMap((s) => s.id.toLowerCase().split(/[-:]/)),
  );
  let best: { id: string; overlap: number } | null = null;
  const supports: Array<{ id: string; overlap: number }> = [];

  for (const agent of agents) {
    const caps = agent.capabilities.concat(agent.domains).map((c) => c.toLowerCase());
    let overlap = 0;
    for (const cap of caps) {
      for (const token of skillTokens) {
        if (cap.includes(token) || token.includes(cap)) {
          overlap++;
          break;
        }
      }
    }
    if (overlap > 0) {
      if (!best || overlap > best.overlap) {
        if (best) supports.push(best);
        best = { id: agent.id, overlap };
      } else {
        supports.push({ id: agent.id, overlap });
      }
    }
  }

  return {
    skills,
    tools,
    ownerAgent: best?.id ?? initiative.ownerAgent ?? null,
    supportAgents: supports.map((s) => s.id),
  };
}

export function formatProposal(
  db: DatabaseSync,
  config: BrainConfig,
  initiativeId: string,
): string {
  const init = getInitiative(db, initiativeId);
  const alignment = alignInitiative(db, config, initiativeId);
  const { score, reasons } = scoreInitiative(init);
  const goal = init.goalId ? getGoal(db, init.goalId) : null;

  return [
    "--------------------------------",
    "NOVA INICIATIVA",
    "--------------------------------",
    `Objetivo: ${goal ? `${goal.name} (${goal.id})` : "-"}`,
    `Iniciativa: ${init.title}`,
    `Descrição: ${init.description || "-"}`,
    `Hipótese: #${init.hypothesisId ?? "-"} (hipótese — não é fato)`,
    `Plano: ${planSummary(db, initiativeId)}`,
    `Owner Agent: ${alignment.ownerAgent ?? "-"}`,
    `Support Agents: ${alignment.supportAgents.join(", ") || "-"}`,
    `Skills: ${[...alignment.skills.primary, ...alignment.skills.supporting].map((s) => s.name).join(", ") || "-"}`,
    `Ferramentas: ${alignment.tools.map((t) => t.id).join(", ") || "-"}`,
    `Custo estimado: R$${init.estimatedCost?.toFixed(2) ?? "0"}`,
    `Risco: ${init.risk ?? "-"}/10`,
    `Resultado esperado: ${init.expectedOutcome || "-"}`,
    `Score: ${score}/100`,
    `Motivo: ${reasons.join("; ")}`,
    `Status: ${init.status === "AWAITING_APPROVAL" ? "AGUARDANDO APROVAÇÃO" : init.approvalStatus}`,
    "--------------------------------",
  ].join("\n");
}

function planSummary(db: DatabaseSync, initiativeId: string): string {
  try {
    planInitiative(db, initiativeId);
  } catch {}
  const rows = db
    .prepare(
      "SELECT ordinal, title FROM initiative_tasks WHERE initiative_id = ? ORDER BY ordinal",
    )
    .all(initiativeId) as unknown as Array<{ ordinal: number; title: string }>;
  return rows.map((r) => `${r.ordinal}.${r.title}`).join(" → ");
}
