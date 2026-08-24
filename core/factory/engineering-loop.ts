import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";

export interface EngineeringLoopResult {
  sessionId: string;
  attempts: number;
  finalStatus: "COMPLETED" | "BLOCKED" | "HUMAN_REVIEW";
  history: Array<{
    attempt: number;
    error: string | null;
    analysis: string;
    changes: string[];
    testsPassed: boolean;
  }>;
}

export interface EngineeringTask {
  taskId: number;
  initiativeId: string;
  description: string;
  workspacePath: string;
  maxRetries: number;
  timeoutMs: number;
}

const MAX_RETRIES = 3;

export function createEngineeringSession(
  db: DatabaseSync,
  input: {
    taskId: number;
    initiativeId: string;
    agentId: string;
    description: string;
    workspacePath: string;
  },
): number {
  const inserted = db
    .prepare(
      `INSERT INTO work_sessions (agent_id, task_id, initiative_id, inputs)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.agentId,
      input.taskId,
      input.initiativeId,
      JSON.stringify({ description: input.description, workspacePath: input.workspacePath }),
    );
  return Number(inserted.lastInsertRowid);
}
