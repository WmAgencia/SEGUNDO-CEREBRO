import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { createGoal, type GoalRecord } from "../goals/goal-engine.ts";
import { listAgents, upsertAgent } from "../agents/agent-runtime.ts";
import { buildWorldState } from "../agents/world-state.ts";
import { persistGoalKnowledge, persistInitiativeKnowledge } from "../obsidian/knowledge-records.ts";
import { createInitiative, planInitiative } from "../goals/initiatives.ts";
import { refreshQueue, assignTask, createHandoff, acceptHandoff } from "../agents/agent-os.ts";
import { SPECIALIZED_AGENTS } from "../agents/specialized.ts";
import { setKillSwitch } from "../autonomous/cycle.ts";
import { OFFICE_DEPARTMENTS, deskPosition, departmentForAgent, officeBounds } from "./office.ts";
import { managerChat } from "./manager.ts";
import { getAllAgentStates } from "./agent-state.ts";

export interface HqSnapshot {
  generatedAt: string;
  office: { departments: typeof OFFICE_DEPARTMENTS; bounds: ReturnType<typeof import("./office.ts").officeBounds> };
  agents: Array<Record<string, unknown>>;
  goals: Array<Record<string, unknown>>;
  initiatives: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  handoffs: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  world: ReturnType<typeof buildWorldState>;
}

export function getHqSnapshot(config: BrainConfig): HqSnapshot {
  const db = new DatabaseSync(config.dbPath);
  try {
    ensureHqAgents(db);
    const rows = (sql: string, ...values: Array<string | number>): Array<Record<string, unknown>> => db.prepare(sql).all(...values) as unknown as Array<Record<string, unknown>>;
    const agents = listAgents(db) as unknown as Array<Record<string, unknown>>;
    const opStates = getAllAgentStates(db);
    const stateMap = new Map(opStates.map(s => [s.agentId, s]));
    const withPositions = agents.map((agent) => {
      const id = String(agent.id);
      const op = stateMap.get(id);
      return { ...agent, position: deskPosition(id), operationalState: op?.state ?? 'OFFLINE', operationalReason: op?.reason ?? null, currentTask: op?.currentTask ?? null, lastActivity: op?.lastActivity ?? null };
    });
    return {
      generatedAt: new Date().toISOString(),
      office: { departments: OFFICE_DEPARTMENTS, bounds: officeBounds() },
      agents: withPositions,
      goals: rows("SELECT id,name,type,status,project,target,current_value,deadline,updated_at FROM goals ORDER BY updated_at DESC LIMIT 20"),
      initiatives: rows("SELECT id,title,status,project,goal_id,owner_agent,updated_at FROM initiatives ORDER BY updated_at DESC LIMIT 20"),
      tasks: rows("SELECT id,title,description,status,assigned_agent,initiative_id,priority,depends_on,started_at,completed_at,result,evidence,workspace,budget,risk_level FROM initiative_tasks ORDER BY id DESC LIMIT 30"),
      runs: rows("SELECT id,agent_id,project_id,state,current_step,retry_count,kill_switch,updated_at FROM agent_runs ORDER BY updated_at DESC LIMIT 20"),
      approvals: rows("SELECT id,type,status,reason,created_at FROM approvals WHERE status='PENDING' ORDER BY created_at DESC LIMIT 20"),
      handoffs: rows("SELECT id,from_agent,to_agent,summary,status,created_at FROM handoffs ORDER BY id DESC LIMIT 15"),
      events: rows("SELECT event_type,subject,payload,occurred_at FROM events ORDER BY id DESC LIMIT 30"),
      world: buildWorldState(config),
    };
  } finally { db.close(); }
}

function ensureHqAgents(db: DatabaseSync): void {
  for (const definition of SPECIALIZED_AGENTS) {
    if (db.prepare("SELECT id FROM agents WHERE id=?").get(definition.id)) continue;
    upsertAgent(db, { id: definition.id, name: definition.name, description: `${definition.department} do Second Brain HQ.`, domains: [definition.id === "manager" ? "management" : definition.department.toLowerCase()], capabilities: definition.responsibilities, permissions: definition.permissions, status: "AVAILABLE" });
  }
}

export interface HqCommandResult {
  ok: boolean;
  message: string;
  goal?: GoalRecord;
  initiativeId?: string;
  taskCount?: number;
  obsidianPath?: string;
  killSwitch?: boolean;
}

const COMMERCIAL_PLAN = [
  "Definir segmentos prioritários",
  "Prospecção de leads qualificados",
  "Preparar abordagem e proposta",
  "Executar outreach comercial",
  "Follow-up e qualificação",
  "Consolidar resultados",
];

export function executeHqCommand(config: BrainConfig, text: string, sessionKey = 'default'): HqCommandResult & { type?: string; intent?: string; actions?: Array<{type:string;status:string}>; requiresConfirmation?: boolean } {
  const response = managerChat(config, text, sessionKey);
  return {
    ok: true,
    message: response.message,
    type: response.type,
    intent: response.intent,
    actions: response.actions,
    requiresConfirmation: response.requiresConfirmation,
  };
}

function dispatchFirst(db: DatabaseSync, initiativeId: string): void {
  const ready = refreshQueue(db, initiativeId);
  if (ready[0] !== undefined) assignTask(db, ready[0], { agentId: "manager", reason: "Manager delegou a primeira task do plano" });
}

function endOfMonthIso(): string {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return end.toISOString().slice(0, 10);
}

function activateKillSwitch(config: BrainConfig): HqCommandResult {
  const db = new DatabaseSync(config.dbPath);
  try {
    setKillSwitch(true);
    db.prepare("UPDATE agent_runs SET kill_switch=1, previous_state=state, state='PAUSED' WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED')").run();
    db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('kill_switch_activated', 'manager', '{}')").run();
    return { ok: true, message: "Kill switch ativado. Runs ativos pausados.", killSwitch: true };
  } finally { db.close(); }
}

function resumeOperations(config: BrainConfig): HqCommandResult {
  const db = new DatabaseSync(config.dbPath);
  try {
    setKillSwitch(false);
    const resumed = db.prepare("UPDATE agent_runs SET kill_switch=0, state='READY' WHERE kill_switch=1 AND state='PAUSED'").run();
    db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('operations_resumed', 'manager', ?)").run(JSON.stringify({ resumed: resumed.changes }));
    return { ok: true, message: `Operações retomadas (${resumed.changes} runs recuperados).`, killSwitch: false };
  } finally { db.close(); }
}

export function requestHandoff(config: BrainConfig, input: { fromAgent: string; toAgent: string; summary: string; taskId?: number; initiativeId?: string }): { handoffId: number; accepted: boolean } {
  const db = new DatabaseSync(config.dbPath);
  try {
    const handoffId = createHandoff(db, { fromAgent: input.fromAgent, toAgent: input.toAgent, summary: input.summary, taskId: input.taskId, initiativeId: input.initiativeId });
    acceptHandoff(db, handoffId, input.toAgent);
    db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('agent_move', ?, ?)").run(
      input.fromAgent,
      JSON.stringify({ agentId: input.fromAgent, to: input.toAgent, reason: "handoff", handoffId }),
    );
    return { handoffId, accepted: true };
  } finally { db.close(); }
}

export function agentProfile(config: BrainConfig, agentId: string): Record<string, unknown> | null {
  const db = new DatabaseSync(config.dbPath);
  try {
    const agent = db.prepare("SELECT * FROM agents WHERE id=?").get(agentId) as Record<string, unknown> | undefined;
    if (!agent) return null;
    const tasks = db.prepare("SELECT id,title,status,started_at,completed_at,result FROM initiative_tasks WHERE assigned_agent=? ORDER BY id DESC LIMIT 10").all(agentId);
    const results = db.prepare("SELECT id,task_id,status,summary,confidence,created_at FROM agent_results WHERE agent_id=? ORDER BY id DESC LIMIT 10").all(agentId);
    const handoffs = db.prepare("SELECT id,from_agent,to_agent,summary,status,created_at FROM handoffs WHERE from_agent=? OR to_agent=? ORDER BY id DESC LIMIT 10").all(agentId, agentId);
    const runs = db.prepare("SELECT id,state,current_step,retry_count,updated_at FROM agent_runs WHERE agent_id=? ORDER BY updated_at DESC LIMIT 5").all(agentId);
    return { agent, department: departmentForAgent(agentId)?.label ?? null, position: deskPosition(agentId), tasks, results, handoffs, runs };
  } finally { db.close(); }
}

export function progressSummary(config: BrainConfig): Record<string, unknown> {
  const db = new DatabaseSync(config.dbPath);
  try {
    const count = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    return {
      activeGoals: count("SELECT COUNT(*) AS n FROM goals WHERE status='ACTIVE'"),
      totalTasks: count("SELECT COUNT(*) AS n FROM initiative_tasks"),
      completedTasks: count("SELECT COUNT(*) AS n FROM initiative_tasks WHERE status='COMPLETED'"),
      failedTasks: count("SELECT COUNT(*) AS n FROM initiative_tasks WHERE status='FAILED'"),
      pendingApprovals: count("SELECT COUNT(*) AS n FROM approvals WHERE status='PENDING'"),
    };
  } finally { db.close(); }
}

export function dispatchInitiative(config: BrainConfig, initiativeId: string, agentId = "manager"): { taskId: number | null; assigned: boolean } {
  const db = new DatabaseSync(config.dbPath);
  try {
    const ready = refreshQueue(db, initiativeId);
    if (ready[0] === undefined) return { taskId: null, assigned: false };
    assignTask(db, ready[0], { agentId, reason: "Manager dispatchou a próxima task segura" });
    return { taskId: ready[0], assigned: true };
  } finally { db.close(); }
}
