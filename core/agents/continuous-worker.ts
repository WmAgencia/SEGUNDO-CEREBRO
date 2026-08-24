import { ProfessionalAgentHarness, type AgentRun, type Budget, type PlanStep, planTask } from "./professional-harness.ts";
import { buildWorldState, type WorldState } from "./world-state.ts";
import type { BrainConfig } from "../config/loader.ts";
import { DatabaseSync } from "node:sqlite";

export interface ContinuousWorkerOptions { budget?: Budget; maxTasks?: number; worker: (step: PlanStep, run: AgentRun, world: WorldState) => Promise<{ ok: boolean; output?: string }>; nextTask?: (world: WorldState, completedTasks: number) => string | null; }
export interface ContinuousWorkerResult { runId: string; tasksCompleted: number; stopReason: string; world: WorldState; }

export async function runContinuousWorker(config: BrainConfig, input: { task: string; agentId: string; projectId?: string }, options: ContinuousWorkerOptions): Promise<ContinuousWorkerResult> {
  const db = new DatabaseSync(config.dbPath);
  try {
    const harness = new ProfessionalAgentHarness(db); let run = harness.start(input); let completed = 0; let reason = "max_tasks";
    const limit = options.maxTasks ?? 1;
    while (completed < limit) {
      const world = buildWorldState(config, input.projectId); const result = await harness.run(run.id, planTask(input.task), (step, current) => options.worker(step, current, world), options.budget);
      if (result.state === "COMPLETED") { completed++; reason = "goal_complete"; } else { reason = result.state.toLowerCase(); break; }
      const next = options.nextTask?.(buildWorldState(config, input.projectId), completed) ?? null;
      if (!next || completed >= limit) break;
      run = harness.start({ ...input, task: next });
    }
    return { runId: run.id, tasksCompleted: completed, stopReason: reason, world: buildWorldState(config, input.projectId) };
  } finally { db.close(); }
}
