/**
 * Agenda API for the single-agent server — real persistence in agenda_events.
 */

import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../../core/config/loader.ts";

export interface AgendaEvent {
  id: number;
  title: string;
  description: string;
  startsAt: string;
  endsAt: string | null;
  project: string | null;
  status: string;
}

export function listAgendaEvents(config: BrainConfig, limit = 30): AgendaEvent[] {
  const db = new DatabaseSync(config.dbPath);
  try {
    return (db.prepare(
      "SELECT id, title, description, starts_at AS startsAt, ends_at AS endsAt, project, status FROM agenda_events ORDER BY starts_at ASC LIMIT ?",
    ).all(limit) as unknown as AgendaEvent[]);
  } finally {
    db.close();
  }
}

export function createAgendaEvent(config: BrainConfig, title: string, startsAt: string, description = ""): AgendaEvent {
  const db = new DatabaseSync(config.dbPath);
  try {
    const parsed = new Date(startsAt);
    if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date: ${startsAt}`);
    const result = db.prepare("INSERT INTO agenda_events (title, description, starts_at, status) VALUES (?, ?, ?, 'scheduled')").run(title, description, parsed.toISOString());
    const id = Number(result.lastInsertRowid);
    return { id, title, description, startsAt: parsed.toISOString(), endsAt: null, project: null, status: "scheduled" };
  } finally {
    db.close();
  }
}