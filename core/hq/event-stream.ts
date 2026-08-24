import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";

export interface HqEvent { id?: number; type: string; subject: string | null; payload: Record<string, unknown>; occurredAt: string; }
export class HqEventStream {
  private readonly emitter = new EventEmitter();
  publish(event: HqEvent): void { this.emitter.emit("event", event); }
  subscribe(listener: (event: HqEvent) => void): () => void { this.emitter.on("event", listener); return () => this.emitter.off("event", listener); }
}

export function recentHqEvents(config: BrainConfig, afterId = 0): HqEvent[] {
  const db = new DatabaseSync(config.dbPath);
  try {
    const rows = db.prepare("SELECT id,event_type,subject,payload,occurred_at FROM events WHERE id>? ORDER BY id ASC LIMIT 100").all(afterId) as unknown as Array<{ id: number; event_type: string; subject: string | null; payload: string; occurred_at: string }>;
    return rows.map((row) => ({ id: row.id, type: row.event_type.toUpperCase(), subject: row.subject, payload: safeJson(row.payload), occurredAt: row.occurred_at }));
  } finally { db.close(); }
}
function safeJson(raw: string): Record<string, unknown> { try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; } }
