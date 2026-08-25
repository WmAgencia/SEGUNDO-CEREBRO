import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { executeEngineeringTask } from "./engineering.ts";
import { refreshQueue } from "../agents/agent-os.ts";
import { createNotification } from "./notifications.ts";
import { persistGoalKnowledge } from "../obsidian/knowledge-records.ts";
import { getGoal, updateGoal } from "../goals/goal-engine.ts";

const NUTRIVA_WORKSPACE = path.resolve(process.cwd(), "apps", "nutriva");
import path from "node:path";

export interface AutonomousResult {
  taskId: number;
  status: 'COMPLETED'|'FAILED';
  output: string;
  nextTaskId: number|null;
  goalComplete: boolean;
}

/**
 * Executes a single task via OpenCode, evaluates the result,
 * creates a notification, and returns the next task to execute.
 */
export async function executeNextTask(config: BrainConfig, taskId: number, agentId: string): Promise<AutonomousResult> {
  const db = new DatabaseSync(config.dbPath);
  try {
    const task = db.prepare("SELECT id,title,initiative_id,workspace FROM initiative_tasks WHERE id=?").get(taskId) as {id:number;title:string;initiative_id:string;workspace:string|null} | undefined;
    if (!task) throw new Error(`Task ${taskId} not found`);

    const workspace = task.workspace ?? NUTRIVA_WORKSPACE;
    const result = await executeEngineeringTask(config, { taskId, agentId, workspacePath: workspace, task: task.title });

    if (result.status === 'COMPLETED') {
      createNotification(db, {
        type: 'task_completed',
        title: `✅ Tarefa concluída: ${task.title}`,
        body: result.output.slice(0, 300),
        agentId, taskId,
      });
    } else {
      createNotification(db, {
        type: 'task_failed',
        title: `❌ Tarefa falhou: ${task.title}`,
        body: result.error?.slice(0, 300) ?? 'Erro desconhecido',
        agentId, taskId,
      });
    }

    // Find next task in the same initiative
    const next = db.prepare(
      "SELECT id FROM initiative_tasks WHERE initiative_id=? AND status='READY' ORDER BY ordinal LIMIT 1"
    ).get(task.initiative_id) as { id: number } | undefined;

    // Check if goal is complete (all tasks done)
    const remaining = db.prepare(
      "SELECT COUNT(*) AS n FROM initiative_tasks WHERE initiative_id=? AND status NOT IN ('COMPLETED','CANCELLED')"
    ).get(task.initiative_id) as { n: number };

    let goalComplete = false;
    const init = db.prepare("SELECT goal_id FROM initiatives WHERE id=?").get(task.initiative_id) as {goal_id:string}|undefined;
    if (init?.goal_id && remaining.n === 0) {
      goalComplete = true;
      const goal = getGoal(db, init.goal_id);
      updateGoal(db, init.goal_id, { status: 'ACHIEVED' });
      persistGoalKnowledge(config, goal);
      createNotification(db, {
        type: 'goal_completed',
        title: `🎉 Objetivo concluído: ${goal.name}`,
        body: 'Todas as tarefas foram finalizadas com sucesso.',
        goalId: init.goal_id,
      });
    }

    return {
      taskId,
      status: result.status,
      output: result.output,
      nextTaskId: next?.id ?? null,
      goalComplete,
    };
  } finally { db.close(); }
}

/**
 * Runs ALL tasks in an initiative sequentially, autonomously.
 * Creates notifications for each step. Stops on failure or kill switch.
 */
export async function runInitiativeAutonomously(config: BrainConfig, initiativeId: string, workspacePath: string): Promise<Array<AutonomousResult>> {
  const db = new DatabaseSync(config.dbPath);
  const results: AutonomousResult[] = [];
  try {
    let nextId: number|null = null;
    const first = db.prepare(
      "SELECT id FROM initiative_tasks WHERE initiative_id=? AND status IN ('READY','ASSIGNED') ORDER BY ordinal LIMIT 1"
    ).get(initiativeId) as { id: number } | undefined;
    nextId = first?.id ?? null;
    db.close();

    while (nextId !== null) {
      // Check kill switch
      const checkDb = new DatabaseSync(config.dbPath);
      const killed = checkDb.prepare("SELECT kill_switch FROM agent_runs WHERE kill_switch=1 AND state='PAUSED' LIMIT 1").get();
      checkDb.close();
      if (killed) break;

      const result = await executeNextTask(config, nextId, 'engineering-agent');
      results.push(result);
      if (result.status === 'FAILED') break;
      nextId = result.nextTaskId;
    }

    return results;
  } finally { db.close(); }
}
