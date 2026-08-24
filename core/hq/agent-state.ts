import { DatabaseSync } from "node:sqlite";

export type AgentOperationalState =
  | 'AVAILABLE' | 'IDLE' | 'WORKING' | 'PAUSED' | 'BLOCKED'
  | 'AWAITING_APPROVAL' | 'OFFLINE' | 'COMPLETED';

export interface AgentOperationalInfo {
  agentId: string;
  state: AgentOperationalState;
  reason: string | null;
  currentTask: string | null;
  currentRunId: string | null;
  lastActivity: string | null;
}

export function getAgentOperationalState(db: DatabaseSync, agentId: string): AgentOperationalInfo {
  const agent = db.prepare("SELECT status FROM agents WHERE id=?").get(agentId) as { status: string } | undefined;
  if (!agent) return { agentId, state: 'OFFLINE', reason: 'Agente não registrado', currentTask: null, currentRunId: null, lastActivity: null };

  const registryStatus = agent.status.toUpperCase();

  // Check for active run
  const run = db.prepare(
    "SELECT id,state FROM agent_runs WHERE agent_id=? AND state NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY updated_at DESC LIMIT 1"
  ).get(agentId) as { id: string; state: string } | undefined;

  // Check for active task
  const task = db.prepare(
    "SELECT title,status FROM initiative_tasks WHERE assigned_agent=? AND status IN ('ASSIGNED','RUNNING','WAITING') ORDER BY id DESC LIMIT 1"
  ).get(agentId) as { title: string; status: string } | undefined;

  // Check for pending approval
  const approval = db.prepare(
    "SELECT id FROM approvals WHERE agent_id=? AND status='PENDING' LIMIT 1"
  ).get(agentId) as { id: number } | undefined;

  // Check last activity
  const lastEvent = db.prepare(
    "SELECT occurred_at FROM events WHERE subject=? ORDER BY id DESC LIMIT 1"
  ).get(agentId) as { occurred_at: string } | undefined;

  const lastActivity = lastEvent?.occurred_at ?? null;

  // Derive operational state
  if (approval) {
    return { agentId, state: 'AWAITING_APPROVAL', reason: 'Aprovação pendente', currentTask: task?.title ?? null, currentRunId: run?.id ?? null, lastActivity };
  }
  if (run && ['RUNNING','PLANNING','EVALUATING','REWORKING'].includes(run.state)) {
    return { agentId, state: 'WORKING', reason: null, currentTask: task?.title ?? null, currentRunId: run.id, lastActivity };
  }
  if (task && task.status === 'WAITING') {
    return { agentId, state: 'AWAITING_APPROVAL', reason: 'Task aguardando revisão', currentTask: task.title, currentRunId: run?.id ?? null, lastActivity };
  }
  if (registryStatus === 'PAUSED') {
    return { agentId, state: 'PAUSED', reason: 'Pausado por comando', currentTask: null, currentRunId: null, lastActivity };
  }
  if (registryStatus === 'BLOCKED') {
    return { agentId, state: 'BLOCKED', reason: 'Bloqueado', currentTask: null, currentRunId: null, lastActivity };
  }
  if (task && ['ASSIGNED','READY'].includes(task.status)) {
    return { agentId, state: 'IDLE', reason: 'Task atribuída, aguardando início', currentTask: task.title, currentRunId: null, lastActivity };
  }
  return { agentId, state: 'AVAILABLE', reason: null, currentTask: null, currentRunId: null, lastActivity };
}

export function getAllAgentStates(db: DatabaseSync): Array<AgentOperationalInfo> {
  const agents = db.prepare("SELECT id FROM agents ORDER BY id").all() as unknown as Array<{ id: string }>;
  return agents.map(a => getAgentOperationalState(db, a.id));
}
