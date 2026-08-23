import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";

export interface ActionPolicyRecord {
  id: number;
  actionType: string;
  riskLevel: string;
  autonomyLevel: string;
  requiresApproval: boolean;
  maxCost: number;
  maxRetries: number;
  constraints: string[];
}

let killSwitchActive = false;

export function activateKillSwitch(db: DatabaseSync, by: string): void {
  killSwitchActive = true;
  db.prepare(
    "INSERT INTO events (event_type, subject, payload) VALUES ('kill_switch_activated', ?, ?)",
  ).run(by, JSON.stringify({ by, at: new Date().toISOString() }));
}

export function deactivateKillSwitch(db: DatabaseSync, by: string): void {
  killSwitchActive = false;
  db.prepare(
    "INSERT INTO events (event_type, subject, payload) VALUES ('kill_switch_deactivated', ?, ?)",
  ).run(by, JSON.stringify({ by }));
}

export function isKillSwitchActive(): boolean {
  return killSwitchActive;
}

export function pauseAgent(db: DatabaseSync, agentId: string): void {
  db.prepare("UPDATE agents SET status='PAUSED' WHERE id=?").run(agentId);
  logEvent(db, "agent_paused", agentId, {});
}

export function resumeAgent(db: DatabaseSync, agentId: string): void {
  db.prepare("UPDATE agents SET status='AVAILABLE' WHERE id=?").run(agentId);
  logEvent(db, "agent_resumed", agentId, {});
}

export function pauseInitiative(db: DatabaseSync, initiativeId: string): void {
  db.prepare("UPDATE initiatives SET status='PAUSED' WHERE id=?").run(initiativeId);
  db.prepare(
    "UPDATE initiative_tasks SET status='BLOCKED' WHERE initiative_id=? AND status IN ('READY','ASSIGNED','RUNNING')",
  ).run(initiativeId);
  logEvent(db, "initiative_paused", initiativeId, {});
}

export function resumeInitiative(db: DatabaseSync, initiativeId: string): void {
  db.prepare("UPDATE initiatives SET status='RUNNING' WHERE id=?").run(initiativeId);
  refreshQueueFor(db, initiativeId);
  logEvent(db, "initiative_resumed", initiativeId, {});
}

function refreshQueueFor(db: DatabaseSync, initiativeId: string): void {
  const rows = db
    .prepare(
      `SELECT t.id, t.depends_on, d.status AS dep_status
       FROM initiative_tasks t
       LEFT JOIN initiative_tasks d ON d.id = t.depends_on
       WHERE t.initiative_id=? AND t.status IN ('BLOCKED','PENDING')`,
    )
    .all(initiativeId) as unknown as Array<{
    id: number; depends_on: number | null; dep_status: string | null;
  }>;
  for (const row of rows) {
    if (!row.depends_on || row.dep_status === "COMPLETED") {
      db.prepare("UPDATE initiative_tasks SET status='READY', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(row.id);
    }
  }
}

export function setActionPolicy(
  db: DatabaseSync,
  input: {
    actionType: string;
    riskLevel: string;
    autonomyLevel: string;
    requiresApproval?: boolean;
    maxCost?: number;
    maxRetries?: number;
    constraints?: string[];
  },
): void {
  if (!input.actionType.trim()) throw new ValidationError("actionType required");
  db.prepare(
    `INSERT INTO policies (action_type, risk_level, autonomy_level, requires_approval, max_cost, max_retries, constraints_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(action_type) DO UPDATE SET
       risk_level=excluded.risk_level, autonomy_level=excluded.autonomy_level,
       requires_approval=excluded.requires_approval, max_cost=excluded.max_cost,
       max_retries=excluded.max_retries, constraints_json=excluded.constraints_json`,
  ).run(
    input.actionType.toUpperCase(),
    input.riskLevel.toUpperCase(),
    input.autonomyLevel.toUpperCase(),
    input.requiresApproval === true ? 1 : 0,
    input.maxCost ?? 0,
    input.maxRetries ?? 3,
    JSON.stringify(input.constraints ?? []),
  );
}

function logEvent(db: DatabaseSync, eventType: string, subject: string | null, payload: Record<string, unknown>): void {
  db.prepare("INSERT INTO events (event_type, subject, payload) VALUES (?, ?, ?)").run(eventType, subject, JSON.stringify(payload));
}
