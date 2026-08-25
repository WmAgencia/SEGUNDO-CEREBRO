import { DatabaseSync } from "node:sqlite";

/**
 * EVENT BUS — emitter único com catálogo tipado (spec §37).
 * Grava na tabela events existente; SSE (/api/hq/events) já consome dela.
 * Provenance embutida no payload: ts, runId, taskId, agentId.
 */

export const BUS_EVENTS = [
  "goal.created", "initiative.created",
  "task.created", "task.assigned", "task.started", "task.completed",
  "task.failed", "task.blocked", "task.rework",
  "agent.started", "agent.paused", "agent.completed", "agent.failed",
  "handoff.created", "handoff.accepted",
  "tool.started", "tool.completed", "tool.failed",
  "approval.created", "approval.approved", "approval.rejected",
  "memory.created", "obsidian.synced",
  "run.orphaned", "run.recovered", "run.checkpoint",
  "n8n.triggered", "n8n.completed", "n8n.failed",
  "budget.exceeded",
] as const;

export type BusEvent = (typeof BUS_EVENTS)[number] | (string & {});

export interface BusPayload {
  subject?: string | null;
  runId?: string;
  taskId?: number;
  agentId?: string;
  initiativeId?: string;
  data?: Record<string, unknown>;
}

export function emitBus(db: DatabaseSync | null, type: BusEvent, payload: BusPayload = {}): void {
  if (!db) return; // chamadores sem DB (ex.: adapter em modo standalone)
  const enriched = {
    ts: new Date().toISOString(),
    ...payload,
    data: payload.data ?? {},
  };
  db.prepare(
    "INSERT INTO events (event_type, subject, payload) VALUES (?, ?, ?)",
  ).run(type, payload.subject ?? payload.agentId ?? null, JSON.stringify(enriched));
}

/** Consulta eventos do bus com filtro por tipo e limite. */
export function recentBusEvents(
  db: DatabaseSync,
  opts: { types?: string[]; limit?: number } = {},
): Array<{ id: number; event_type: string; subject: string | null; payload: string; occurred_at: string }> {
  if (opts.types?.length) {
    const placeholders = opts.types.map(() => "?").join(",");
    return db.prepare(
      `SELECT id, event_type, subject, payload, occurred_at FROM events
       WHERE event_type IN (${placeholders}) ORDER BY id DESC LIMIT ?`,
    ).all(...opts.types, opts.limit ?? 50) as unknown as Array<Record<string, never>> as never;
  }
  return db.prepare(
    "SELECT id, event_type, subject, payload, occurred_at FROM events ORDER BY id DESC LIMIT ?",
  ).all(opts.limit ?? 50) as unknown as Array<Record<string, never>> as never;
}
