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
    const withPositions = agents.map((agent) => ({ ...agent, position: deskPosition(String(agent.id)) }));
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
    upsertAgent(db, { id: definition.id, name: definition.name, description: `${definition.department} do Second Brain HQ.`, domains: [definition.id === "manager" ? "management" : definition.department.toLowerCase()], capabilities: definition.responsibilities, permissions: definition.permissions, status: definition.id === "manager" ? "AVAILABLE" : "PAUSED" });
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

export function executeHqCommand(config: BrainConfig, text: string): HqCommandResult {
  const command = text.trim();
  if (!command) return { ok: false, message: "Digite uma ordem para o Manager." };

  if (/^(pare tudo|para tudo|kill switch|stop everything)$/i.test(command)) return activateKillSwitch(config);
  if (/^(continue|continue a iniciativa atual|retomar|resume)$/i.test(command)) return resumeOperations(config);

  const goalMatch = command.match(/(?:criar|definir|iniciar|quero|precisamos).*?(?:objetivo|goal)\s*(?:de|para|:)?\s*(.+)$/i) ?? command.match(/(?:quero|precisamos)\s+(?:alcan[cç]ar|faturar|fazer)\s+(.+)$/i);
  if (goalMatch?.[1]) {
    const name = goalMatch[1].trim().replace(/\s+até\s+.*$/i, "").trim();
    const deadlineMatch = command.match(/até\s+(?:o\s+final\s+do\s+mês|dia\s+([\d/]+))/i);
    const isCommercial = /r\$\s*[\d.,]+|venda|vendas|faturar|receita|lead/i.test(command);
    const db = new DatabaseSync(config.dbPath);
    try {
      ensureHqAgents(db);
      const goal = createGoal(db, {
        name,
        type: isCommercial ? "FINANCIAL" : "PROJECT",
        status: "ACTIVE",
        ownerAgent: "manager",
        metricName: isCommercial ? "receita" : undefined,
        target: isCommercial ? Number((command.match(/r\$\s*([\d.,]+)/i)?.[1] ?? "").replace(/\./g, "").replace(",", ".")) || undefined : undefined,
        currentValue: isCommercial ? 0 : undefined,
        deadline: deadlineMatch?.[1] ?? (deadlineMatch ? endOfMonthIso() : undefined),
      });
      const obsidianPath = persistGoalKnowledge(config, goal);
      db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('command_center_order', 'manager', ?)").run(JSON.stringify({ text: command, goalId: goal.id }));

      let initiativeId: string | undefined;
      let taskCount: number | undefined;
      let initiativePath: string | undefined;

      if (/nutriva/i.test(command)) {
        const initiative = createInitiative(db, { title: `MVP Nutriva: ${goal.name}`, description: "Plano inicial de desenvolvimento do Nutriva.", goalId: goal.id, project: "nutriva", status: "PROPOSED" });
        const plan = planInitiative(db, initiative.id, ["Auditar estado atual do Nutriva", "Implementar próxima melhoria de baixo risco", "Executar testes e avaliação"]);
        dispatchFirst(db, initiative.id);
        initiativeId = initiative.id; taskCount = plan.length;
        initiativePath = persistInitiativeKnowledge(config, goal, initiative, plan.map((t) => t.title));
      } else if (isCommercial) {
        const initiative = createInitiative(db, { title: `Aquisição comercial: ${name}`, description: "Plano comercial para atingir a meta.", goalId: goal.id, project: "consecom", status: "PROPOSED" });
        const plan = planInitiative(db, initiative.id, COMMERCIAL_PLAN);
        dispatchFirst(db, initiative.id);
        initiativeId = initiative.id; taskCount = plan.length;
        initiativePath = persistInitiativeKnowledge(config, goal, initiative, plan.map((t) => t.title));
      }

      return {
        ok: true,
        message: initiativeId ? `Goal criado com ${taskCount} tasks: ${goal.name}` : `Goal criado: ${goal.name}`,
        goal, initiativeId, taskCount, obsidianPath: initiativePath ?? obsidianPath,
      };
    } finally { db.close(); }
  }

  if (/status|progresso|o que est[aá] acontecendo|como est[aá]/i.test(command)) {
    const world = buildWorldState(config);
    const active = world.counts["goals"] ?? 0;
    const running = world.activeRuns.length;
    return { ok: true, message: `${active} goals no banco, ${running} runs ativos, ${world.blockedRuns.length} bloqueados.` };
  }

  if (/por que.*bloquead/i.test(command)) {
    const db = new DatabaseSync(config.dbPath);
    try {
      const blocked = db.prepare("SELECT id,state,retry_count FROM agent_runs WHERE state IN ('BLOCKED','WAITING_HUMAN') ORDER BY updated_at DESC LIMIT 3").all() as unknown as Array<{ id: string; state: string; retry_count: number }>;
      const message = blocked.length ? blocked.map((b) => `${b.id}: ${b.state} (retries=${b.retry_count})`).join("; ") : "Nenhum run bloqueado agora.";
      return { ok: true, message };
    } finally { db.close(); }
  }

  return { ok: true, message: "Comando recebido pelo Manager; nenhuma ação automatizada mapeada para este texto." };
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
