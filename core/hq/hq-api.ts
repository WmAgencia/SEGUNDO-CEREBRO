import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { createGoal, type GoalRecord } from "../goals/goal-engine.ts";
import { listAgents, upsertAgent } from "../agents/agent-runtime.ts";
import { buildWorldState } from "../agents/world-state.ts";
import { persistGoalKnowledge } from "../obsidian/knowledge-records.ts";
import { persistInitiativeKnowledge } from "../obsidian/knowledge-records.ts";
import { createInitiative, planInitiative } from "../goals/initiatives.ts";
import { refreshQueue, assignTask } from "../agents/agent-os.ts";
import { SPECIALIZED_AGENTS } from "../agents/specialized.ts";

export const HQ_DEPARTMENTS = ["MANAGER / GESTÃO", "MARKETING", "DESIGN", "SOCIAL MEDIA", "TRÁFEGO PAGO", "PROSPECÇÃO", "COMERCIAL", "DESENVOLVIMENTO", "PESQUISA / INTELIGÊNCIA", "MANUTENÇÃO"] as const;

export interface HqSnapshot {
  generatedAt: string;
  departments: Array<{ id: string; label: string; agentId: string | null; status: string }>;
  agents: Array<Record<string, unknown>>;
  goals: Array<Record<string, unknown>>;
  initiatives: Array<Record<string, unknown>>;
  tasks: Array<Record<string, unknown>>;
  runs: Array<Record<string, unknown>>;
  approvals: Array<Record<string, unknown>>;
  events: Array<Record<string, unknown>>;
  world: ReturnType<typeof buildWorldState>;
}

export function getHqSnapshot(config: BrainConfig): HqSnapshot {
  const db = new DatabaseSync(config.dbPath);
  try {
    ensureHqAgents(db);
    const rows = (sql: string, ...values: Array<string | number>): Array<Record<string, unknown>> => db.prepare(sql).all(...values) as unknown as Array<Record<string, unknown>>;
    const agents = listAgents(db) as unknown as Array<Record<string, unknown>>;
    const byDepartment = new Map<string, Record<string, unknown>>();
    for (const agent of agents) for (const domain of (Array.isArray(agent.domains) ? agent.domains : [])) byDepartment.set(String(domain).toUpperCase(), agent);
    return {
      generatedAt: new Date().toISOString(),
      departments: HQ_DEPARTMENTS.map((label) => { const key = label.startsWith("MANAGER") ? "MANAGEMENT" : label.split(" ")[0] ?? ""; const agent = byDepartment.get(key); return { id: label.toLowerCase().replace(/[^a-z]+/g, "-"), label, agentId: agent ? String(agent.id) : null, status: agent ? String(agent.status) : "UNASSIGNED" }; }),
      agents,
      goals: rows("SELECT id,name,type,status,project,target,current_value,deadline,updated_at FROM goals ORDER BY updated_at DESC LIMIT 20"),
      initiatives: rows("SELECT id,title,status,project,goal_id,owner_agent,updated_at FROM initiatives ORDER BY updated_at DESC LIMIT 20"),
      tasks: rows("SELECT id,title,description,status,assigned_agent,initiative_id,priority,depends_on,started_at,completed_at,result,evidence,workspace,budget,risk_level FROM initiative_tasks ORDER BY id DESC LIMIT 30"),
      runs: rows("SELECT id,agent_id,project_id,state,current_step,retry_count,kill_switch,updated_at FROM agent_runs ORDER BY updated_at DESC LIMIT 20"),
      approvals: rows("SELECT id,type,status,reason,created_at FROM approvals WHERE status='PENDING' ORDER BY created_at DESC LIMIT 20"),
      events: rows("SELECT event_type,subject,payload,occurred_at FROM events ORDER BY id DESC LIMIT 30"),
      world: buildWorldState(config),
    };
  } finally { db.close(); }
}

function ensureHqAgents(db: DatabaseSync): void {
  for (const definition of SPECIALIZED_AGENTS) {
    if (db.prepare("SELECT id FROM agents WHERE id=?").get(definition.id)) continue;
    upsertAgent(db, { id: definition.id, name: definition.name, description: `${definition.department} do Second Brain HQ.`, domains: [definition.id === "manager" ? "management" : definition.department.toLowerCase()], capabilities: definition.responsibilities, permissions: definition.permissions, status: definition.id === "manager" ? "AVAILABLE" : "PAUSED" });
  }
}

export function executeHqCommand(config: BrainConfig, text: string): { ok: boolean; message: string; goal?: GoalRecord; initiativeId?: string; taskCount?: number; obsidianPath?: string } {
  const command = text.trim();
  if (!command) return { ok: false, message: "Digite uma ordem para o Manager." };
  const goalMatch = command.match(/(?:criar|definir|iniciar).*?(?:objetivo|goal)\s*(?:de|para|:)?\s*(.+)$/i);
  if (goalMatch?.[1]) {
    const db = new DatabaseSync(config.dbPath);
    try {
      ensureHqAgents(db);
      const goal = createGoal(db, { name: goalMatch[1].trim(), type: "PROJECT", status: "ACTIVE", ownerAgent: "manager" });
      const obsidianPath = persistGoalKnowledge(config, goal);
      if (!/nutriva/i.test(command)) return { ok: true, message: `Goal criado: ${goal.name}`, goal, obsidianPath };
      const initiative = createInitiative(db, { title: `MVP Nutriva: ${goal.name}`, description: "Plano inicial de desenvolvimento do Nutriva.", goalId: goal.id, project: "nutriva", status: "PROPOSED" });
      const plan = planInitiative(db, initiative.id, ["Auditar estado atual do Nutriva", "Implementar próxima melhoria de baixo risco", "Executar testes e avaliação"]);
      const ready = refreshQueue(db, initiative.id);
      if (ready[0] !== undefined) assignTask(db, ready[0], { agentId: "manager", reason: "Manager delegou a primeira task do plano" });
      const initiativePath = persistInitiativeKnowledge(config, goal, initiative, plan.map((task) => task.title));
      return { ok: true, message: `Goal e iniciativa criados: ${goal.name}`, goal, initiativeId: initiative.id, taskCount: plan.length, obsidianPath: initiativePath };
    } finally { db.close(); }
  }
  if (/status|o que est[aá] acontecendo|progresso/i.test(command)) return { ok: true, message: "Snapshot atualizado no HQ." };
  return { ok: true, message: "Comando recebido pelo Manager; execução específica ainda não implementada." };
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
