import { DatabaseSync } from "node:sqlite";
import { ValidationError, NotFoundError } from "../errors/errors.ts";
import type { BrainConfig } from "../config/loader.ts";
import { getInitiative, updateInitiativeStatus } from "../goals/initiatives.ts";
import { selectAgent } from "./agent-os.ts";
import {
  assignTask,
  refreshQueue,
} from "./agent-os.ts";

export interface OrchestratorCycleResult {
  initiativeId: string;
  status: string;
  assigned: Array<{ taskId: number; agentId: string; title: string }>;
  ready: number[];
  blocked: Array<{ taskId: number; title: string }>;
  completedCount: number;
  totalCount: number;
  progressPct: number;
  done: boolean;
}

function countByStatus(
  db: DatabaseSync,
  initiativeId: string,
): Record<string, number> {
  const rows = db
    .prepare(
      "SELECT status, COUNT(*) AS c FROM initiative_tasks WHERE initiative_id = ? GROUP BY status",
    )
    .all(initiativeId) as unknown as Array<{ status: string; c: number }>;
  const map: Record<string, number> = {};
  for (const r of rows) map[r.status] = r.c;
  return map;
}

export function orchestrateCycle(
  config: BrainConfig,
  args: { initiativeId: string; autoAssign?: boolean },
): OrchestratorCycleResult {
  const initiativeId = args.initiativeId;
  const options = { autoAssign: args.autoAssign };
  const db = new DatabaseSync(config.dbPath);
  try {
    const initiative = getInitiative(db, initiativeId);
    if (initiative.status !== "APPROVED" && initiative.status !== "RUNNING") {
      throw new ValidationError(
        `iniciativa precisa estar APPROVED ou RUNNING (atual: ${initiative.status})`,
      );
    }
    if (initiative.status === "APPROVED") {
      updateInitiativeStatus(db, initiativeId, "RUNNING");
    }

    refreshQueue(db, initiativeId);

    const assigned: OrchestratorCycleResult["assigned"] = [];
    if (options.autoAssign !== false) {
      for (let guard = 0; guard < 50; guard++) {
        const readyRow = db
          .prepare(
            `SELECT id, title FROM initiative_tasks
             WHERE initiative_id=? AND status='READY'
             ORDER BY ordinal LIMIT 1`,
          )
          .get(initiativeId) as { id: number; title: string } | undefined;
        if (!readyRow || !readyRow.id) break;

        try {
          const res = assignTask(db, readyRow.id, {});
          assigned.push({ taskId: res.taskId, agentId: res.agentId, title: readyRow.title });
        } catch {
          break;
        }
      }
    }

    const counts = countByStatus(db, initiativeId);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const completed = counts["COMPLETED"] ?? 0;
    const blockedRows = db
      .prepare(
        `SELECT id, title FROM initiative_tasks
         WHERE initiative_id=? AND status IN ('BLOCKED','FAILED') ORDER BY ordinal`,
      )
      .all(initiativeId) as unknown as Array<{ id: number; title: string }>;

    const readyRows = db
      .prepare(
        `SELECT id FROM initiative_tasks WHERE initiative_id=? AND status='READY'`,
      )
      .all(initiativeId) as unknown as Array<{ id: number }>;
    const ready = readyRows.map((r) => r.id);

    const done = total > 0 && completed === total;
    if (done) {
      updateInitiativeStatus(db, initiativeId, "COMPLETED");
    }

    return {
      initiativeId,
      status: done ? "COMPLETED" : initiative.status === "APPROVED" ? "RUNNING" : initiative.status,
      assigned,
      ready,
      blocked: blockedRows.map((b) => ({ taskId: b.id, title: b.title })),
      completedCount: completed,
      totalCount: total,
      progressPct: total === 0 ? 0 : Math.round((completed / total) * 100),
      done,
    };
  } finally {
    db.close();
  }
}

export function createTeam(
  db: DatabaseSync,
  input: {
    id?: string;
    name: string;
    description?: string;
    managerAgent?: string;
    members?: string[];
    capabilities?: string[];
    projects?: string[];
  },
): Record<string, unknown> {
  if (!input.name.trim()) throw new ValidationError("team name is required");
  const id =
    input.id ??
    `team.${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
  db.prepare(
    `INSERT INTO teams (id, name, description, manager_agent, members, capabilities, projects)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name=excluded.name, description=excluded.description,
       manager_agent=excluded.manager_agent, members=excluded.members,
       capabilities=excluded.capabilities, projects=excluded.projects`,
  ).run(
    id,
    input.name,
    input.description ?? "",
    input.managerAgent ?? null,
    JSON.stringify(input.members ?? []),
    JSON.stringify(input.capabilities ?? []),
    JSON.stringify(input.projects ?? []),
  );
  return getTeam(db, id);
}

export function getTeam(db: DatabaseSync, id: string): Record<string, unknown> {
  const row = db.prepare("SELECT * FROM teams WHERE id = ?").get(id) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new NotFoundError(`team not found: ${id}`);
  return row;
}

export function listTeams(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM teams ORDER BY id").all() as unknown as Array<
    Record<string, unknown>
  >;
}

export function dispatchToTeam(
  config: BrainConfig,
  args: { initiativeId: string; teamId: string },
): { dispatched: Array<{ taskId: number; agentId: string; title: string }> } {
  const db = new DatabaseSync(config.dbPath);
  try {
    const team = getTeam(db, String(args.teamId));
    const members = JSON.parse(String(team.members ?? "[]")) as string[];
    if (!Array.isArray(members) || members.length === 0) {
      throw new ValidationError("team has no members");
    }

    const tasks = db
      .prepare(
        `SELECT id, title FROM initiative_tasks
         WHERE initiative_id=? AND status IN ('READY','ASSIGNED')
         ORDER BY ordinal`,
      )
      .all(args.initiativeId) as unknown as Array<{ id: number; title: string }>;

    const dispatched: Array<{ taskId: number; agentId: string; title: string }> = [];
    let memberIndex = 0;
    for (const task of tasks) {
      if (task.title.toUpperCase().includes("APROVAÇÃO")) continue;
      const agentId = (members[memberIndex % members.length] ?? members[0]) as string;
      memberIndex++;
      try {
        assignTask(db, task.id, {
          agentId,
          reason: `delegado pela team ${args.teamId}`,
        });
        dispatched.push({ taskId: task.id, agentId, title: task.title });
      } catch {
        // task pode já ter sido atribuída por outro caminho; segue
      }
    }
    return { dispatched };
  } finally {
    db.close();
  }
}
