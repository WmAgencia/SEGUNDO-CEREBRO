import { DatabaseSync } from "node:sqlite";
import { ValidationError, NotFoundError } from "../errors/errors.ts";
import type { BrainConfig } from "../config/loader.ts";
import { evaluatePolicy } from "./policy.ts";
import { LocalExecutor } from "./executor.ts";
import { redactSecrets } from "./redact.ts";
import {
  requestApproval,
  listPendingApprovals,
} from "../agents/agent-os.ts";

export interface ExecutionRecord {
  id: number;
  taskId: number | null;
  initiativeId: string | null;
  agentId: string;
  toolId: string;
  status: string;
  risk: string;
  error: string | null;
  output: string | null;
}

interface RawExecution {
  id: number;
  task_id: number | null;
  initiative_id: string | null;
  agent_id: string;
  tool_id: string;
  input: string;
  status: string;
  risk: string;
  idempotency_key: string | null;
  attempts: number;
  max_retries: number;
  timeout_ms: number;
  error: string | null;
  output: string | null;
}

function toExecution(r: RawExecution): ExecutionRecord {
  return {
    id: r.id,
    taskId: r.task_id,
    initiativeId: r.initiative_id,
    agentId: r.agent_id,
    toolId: r.tool_id,
    status: r.status,
    risk: r.risk,
    error: r.error,
    output: r.output,
  };
}

export function requestExecution(
  config: BrainConfig,
  executor: LocalExecutor,
  input: {
    agentId: string;
    toolId: string;
    taskId?: number;
    initiativeId?: string;
    projectId?: string;
    params?: Record<string, unknown>;
    idempotencyKey?: string;
    timeoutMs?: number;
    maxRetries?: number;
  },
): ExecutionRecord & { duplicate: boolean } {
  if (!input.agentId || !input.toolId) {
    throw new ValidationError("agentId e toolId são obrigatórios");
  }

  const db = new DatabaseSync(config.dbPath);
  try {
    if (input.idempotencyKey) {
      const prior = db
        .prepare("SELECT * FROM executions WHERE idempotency_key = ?")
        .get(input.idempotencyKey) as unknown as RawExecution | undefined;
      if (prior) {
        return { ...toExecution(prior), duplicate: true };
      }
    }
  } finally {
    db.close();
  }

  const db2 = new DatabaseSync(config.dbPath);
  try {
    const policy = evaluatePolicy(db2, {
      agentId: input.agentId,
      toolId: input.toolId,
      taskId: input.taskId,
      initiativeId: input.initiativeId,
      projectId: input.projectId,
    });

    let status = policy.decision === "ALLOWED" ? "AUTHORIZED" : policy.decision;

    const inserted = db2
      .prepare(
        `INSERT INTO executions (task_id, initiative_id, agent_id, tool_id, input, status, risk, idempotency_key, max_retries, timeout_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId ?? null,
        input.initiativeId ?? null,
        input.agentId,
        input.toolId,
        JSON.stringify(input.params ?? {}),
        status,
        policy.risk,
        input.idempotencyKey ?? null,
        input.maxRetries ?? 1,
        input.timeoutMs ?? 30000,
      );
    const executionId = Number(inserted.lastInsertRowid);

    logEvent(db2, "execution_requested", input.agentId, {
      executionId,
      toolId: input.toolId,
      decision: policy.decision,
    });

    if (policy.decision === "REQUIRES_APPROVAL") {
      requestApproval(db2, {
        taskId: input.taskId,
        initiativeId: input.initiativeId,
        agentId: input.agentId,
        type: "EXTERNAL_ACTION",
        reason: `execução de ${input.toolId} requer aprovação humana (risco ${policy.risk})`,
        payload: { execution_id: executionId },
      });
    }

    return {
      ...getExecutionRow(db2, executionId),
      duplicate: false,
    };
  } finally {
    db2.close();
  }
}

export function getExecutionRow(db: DatabaseSync, id: number): ExecutionRecord {
  const row = db.prepare("SELECT * FROM executions WHERE id = ?").get(id) as
    | RawExecution
    | undefined;
  if (!row) throw new NotFoundError(`execution not found: ${id}`);
  return toExecution(row);
}

export async function runAuthorizedExecution(
  config: BrainConfig,
  executor: LocalExecutor,
  executionId: number,
): Promise<ExecutionRecord> {
  const db = new DatabaseSync(config.dbPath);
  try {
    const row = db
      .prepare("SELECT * FROM executions WHERE id = ?")
      .get(executionId) as unknown as RawExecution | undefined;
    if (!row) throw new NotFoundError(`execution not found: ${executionId}`);

    if (row.status !== "AUTHORIZED") {
      throw new ValidationError(`execution ${executionId} status=${row.status}, não AUTHORIZED`);
    }

    const startedAt = new Date().toISOString();
    db.prepare(
      "UPDATE executions SET status='RUNNING', started_at=?, attempts=attempts+1 WHERE id=?",
    ).run(startedAt, executionId);
    logEvent(db, "execution_started", row.agent_id, { executionId });

    let handlerOutput: { output: string; summary: string; artifacts?: string[] };
    try {
      const timeoutMs = row.timeout_ms || 30000;
      const signal = AbortSignal.timeout(timeoutMs);
      const ctx = { taskId: row.task_id ?? undefined, initiativeId: row.initiative_id ?? undefined, agentId: row.agent_id, signal };
      const parsedInput = JSON.parse(row.input) as Record<string, unknown>;

      handlerOutput = await Promise.race([
        executor.execute(row.tool_id, parsedInput, ctx),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeoutMs),
        ),
      ]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes("timeout") ||
        msg.includes("ECONNREFUSED") ||
        msg.includes("network");

      const canRetry = isTransient && row.attempts <= row.max_retries;
      db.prepare(
        "UPDATE executions SET status=?, error=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
      ).run(canRetry ? "AUTHORIZED" : "FAILED", redactSecrets(msg), executionId);
      logEvent(db, canRetry ? "execution_retry" : "execution_failed", row.agent_id, {
        executionId,
        error: redactSecrets(msg),
        retry: canRetry,
      });
      throw err;
    }

    const durationMs = Date.now() - Date.parse(startedAt);
    db.prepare(
      "UPDATE executions SET status='COMPLETED', output=?, completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
    ).run(handlerOutput.output, executionId);

    db.prepare(
      `INSERT INTO execution_results (execution_id, tool_id, agent_id, task_id, status, output, summary, artifacts, duration_ms)
       VALUES (?, ?, ?, ?, 'COMPLETED', ?, ?, ?, ?)`,
    ).run(
      executionId,
      row.tool_id,
      row.agent_id,
      row.task_id,
      handlerOutput.output,
      handlerOutput.summary,
      JSON.stringify(handlerOutput.artifacts ?? []),
      durationMs,
    );

    logEvent(db, "execution_completed", row.agent_id, { executionId, durationMs });

    return getExecutionRow(db, executionId);
  } finally {
    db.close();
  }
}

export function listExecutions(
  config: BrainConfig,
  filters: { agentId?: string; initiativeId?: string; status?: string; limit?: number } = {},
): ExecutionRecord[] {
  const db = new DatabaseSync(config.dbPath);
  try {
    const where: string[] = [];
    const values: Array<string | number> = [];
    if (filters.agentId) {
      where.push("agent_id = ?");
      values.push(filters.agentId);
    }
    if (filters.initiativeId) {
      where.push("initiative_id = ?");
      values.push(filters.initiativeId);
    }
    if (filters.status) {
      where.push("status = ?");
      values.push(filters.status);
    }
    const limit = Math.max(1, Math.min(100, filters.limit ?? 20));
    const rows = db
      .prepare(
        `SELECT * FROM executions ${where.length ? "WHERE " + where.join(" AND ") : ""}
         ORDER BY requested_at DESC LIMIT ${limit}`,
      )
      .all(...values) as unknown as RawExecution[];
    return rows.map(toExecution);
  } finally {
    db.close();
  }
}

export function checkApprovedExecution(
  db: DatabaseSync,
  executionId: number,
): boolean {
  const rows = db
    .prepare(
      `SELECT payload FROM approvals WHERE payload LIKE ?
       AND status = 'APPROVED'`,
    )
    .all(`%"execution_id":${executionId}%`) as unknown as unknown[];
  return rows.length > 0;
}

export function logEvent(
  db: DatabaseSync,
  eventType: string,
  subject: string | null,
  payload: Record<string, unknown>,
): void {
  db.prepare(
    "INSERT INTO events (event_type, subject, payload) VALUES (?, ?, ?)",
  ).run(eventType, subject, JSON.stringify(payload));
}
