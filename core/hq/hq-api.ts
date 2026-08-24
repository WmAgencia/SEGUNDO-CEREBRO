import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { createGoal, type GoalRecord } from "../goals/goal-engine.ts";
import { listAgents, upsertAgent } from "../agents/agent-runtime.ts";
import { buildWorldState } from "../agents/world-state.ts";
import { persistGoalKnowledge } from "../obsidian/knowledge-records.ts";

export const HQ_DEPARTMENTS = ["MANAGEMENT", "SALES", "MARKETING", "ENGINEERING", "DESIGN", "RESEARCH", "CUSTOMER SUCCESS", "FINANCE", "OPERATIONS", "KNOWLEDGE / SECOND BRAIN"] as const;

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
    if (!db.prepare("SELECT id FROM agents WHERE id='manager'").get()) upsertAgent(db, { id: "manager", name: "Manager", description: "Orchestrator do Second Brain HQ.", domains: ["management", "orchestration"], capabilities: ["planning", "delegation", "evaluation"], tools: ["brain_context", "brain_search"], permissions: ["context", "orchestration"], status: "AVAILABLE" });
    const rows = (sql: string, ...values: Array<string | number>): Array<Record<string, unknown>> => db.prepare(sql).all(...values) as unknown as Array<Record<string, unknown>>;
    const agents = listAgents(db) as unknown as Array<Record<string, unknown>>;
    const byDepartment = new Map<string, Record<string, unknown>>();
    for (const agent of agents) for (const domain of (Array.isArray(agent.domains) ? agent.domains : [])) byDepartment.set(String(domain).toUpperCase(), agent);
    return {
      generatedAt: new Date().toISOString(),
      departments: HQ_DEPARTMENTS.map((label) => { const agent = byDepartment.get(label.split(" ")[0] ?? ""); return { id: label.toLowerCase().replace(/[^a-z]+/g, "-"), label, agentId: agent ? String(agent.id) : null, status: agent ? String(agent.status) : "UNASSIGNED" }; }),
      agents,
      goals: rows("SELECT id,name,type,status,priority,project,target,current_value,deadline,updated_at FROM goals ORDER BY priority ASC, updated_at DESC LIMIT 20"),
      initiatives: rows("SELECT id,title,status,project,goal_id,owner_agent,updated_at FROM initiatives ORDER BY updated_at DESC LIMIT 20"),
      tasks: rows("SELECT id,title,status,assigned_agent,initiative_id FROM initiative_tasks ORDER BY id DESC LIMIT 30"),
      runs: rows("SELECT id,agent_id,project_id,state,current_step,retry_count,kill_switch,updated_at FROM agent_runs ORDER BY updated_at DESC LIMIT 20"),
      approvals: rows("SELECT id,type,status,reason,created_at FROM approvals WHERE status='PENDING' ORDER BY created_at DESC LIMIT 20"),
      events: rows("SELECT event_type,subject,payload,occurred_at FROM events ORDER BY id DESC LIMIT 30"),
      world: buildWorldState(config),
    };
  } finally { db.close(); }
}

export function executeHqCommand(config: BrainConfig, text: string): { ok: boolean; message: string; goal?: GoalRecord; obsidianPath?: string } {
  const command = text.trim();
  if (!command) return { ok: false, message: "Digite uma ordem para o Manager." };
  const goalMatch = command.match(/(?:criar|definir|iniciar).*?(?:objetivo|goal)\s*(?:de|para|:)?\s*(.+)$/i);
  if (goalMatch?.[1]) {
    const db = new DatabaseSync(config.dbPath);
    try {
      const goal = createGoal(db, { name: goalMatch[1].trim(), type: "PROJECT", status: "ACTIVE", ownerAgent: "manager" });
      const obsidianPath = persistGoalKnowledge(config, goal);
      return { ok: true, message: `Goal criado: ${goal.name}`, goal, obsidianPath };
    } finally { db.close(); }
  }
  if (/status|o que est[aá] acontecendo|progresso/i.test(command)) return { ok: true, message: "Snapshot atualizado no HQ." };
  return { ok: true, message: "Comando recebido pelo Manager; execução específica ainda não implementada." };
}
