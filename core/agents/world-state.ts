import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { BrainConfig } from "../config/loader.ts";

export interface WorldState {
  generatedAt: string;
  project?: string;
  counts: Record<string, number>;
  health: { database: boolean; vault: boolean; opencode: boolean };
  activeRuns: string[];
  blockedRuns: string[];
  recentFailures: string[];
}

export function buildWorldState(config: BrainConfig, project?: string): WorldState {
  const db = new DatabaseSync(config.dbPath);
  try {
    const count = (table: string, where = ""): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n);
    const counts: Record<string, number> = {};
    for (const table of ["goals", "initiatives", "initiative_tasks", "agents", "agent_runs", "memories", "decisions", "research_questions", "opportunities", "events"]) {
      try { counts[table] = count(table); } catch { counts[table] = 0; }
    }
    const activeRuns = db.prepare("SELECT id FROM agent_runs WHERE state NOT IN ('COMPLETED','FAILED','CANCELLED') ORDER BY updated_at DESC LIMIT 20").all().map((r) => String((r as { id: string }).id));
    const blockedRuns = db.prepare("SELECT id FROM agent_runs WHERE state IN ('BLOCKED','WAITING_HUMAN') ORDER BY updated_at DESC LIMIT 20").all().map((r) => String((r as { id: string }).id));
    const recentFailures = db.prepare("SELECT event FROM agent_traces WHERE event LIKE '%fail%' ORDER BY created_at DESC LIMIT 10").all().map((r) => String((r as { event: string }).event));
    return { generatedAt: new Date().toISOString(), project, counts, health: { database: true, vault: existsSync(config.vaultPath), opencode: existsSync("node_modules/.bin/opencode") }, activeRuns, blockedRuns, recentFailures };
  } finally { db.close(); }
}
