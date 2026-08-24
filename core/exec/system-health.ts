import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import type { BrainConfig } from "../config/loader.ts";

export interface SubsystemHealth {
  database: { ok: boolean; detail: string };
  memoryEngine: { ok: boolean; count: number };
  vaultAccess: { ok: boolean; path: string };
  evolutionConfigured: { ok: boolean; state: string };
}

export interface SystemHealth {
  overall: "HEALTHY" | "DEGRADED" | "CRITICAL";
  subsystems: SubsystemHealth;
  checkedAt: string;
}

export function getSystemHealth(config: BrainConfig): SystemHealth {
  const subsystems: SubsystemHealth = {
    database: checkDatabase(config),
    memoryEngine: checkMemoryEngine(config),
    vaultAccess: checkVault(config),
    evolutionConfigured: checkEvolutionConfig(),
  };

  const failures = Object.values(subsystems).filter((s) => !s.ok).length;
  return {
    overall: failures === 0 ? "HEALTHY" : failures <= 1 ? "DEGRADED" : "CRITICAL",
    subsystems,
    checkedAt: new Date().toISOString(),
  };
}

function checkDatabase(config: BrainConfig): { ok: boolean; detail: string } {
  try {
    const db = new DatabaseSync(config.dbPath);
    const tables = db.prepare(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table'"
    ).get() as { c: number };
    db.close();
    return { ok: tables.c >= 15, detail: `${tables.c} tables` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : "unknown" };
  }
}

function checkMemoryEngine(config: BrainConfig): { ok: boolean; count: number } {
  try {
    const db = new DatabaseSync(config.dbPath);
    const row = db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
    db.close();
    return { ok: row.c > 0, count: row.c };
  } catch {
    return { ok: false, count: 0 };
  }
}

function checkVault(config: BrainConfig): { ok: boolean; path: string } {
  return { ok: existsSync(config.vaultPath), path: config.vaultPath };
}

function checkEvolutionConfig(): { ok: boolean; state: string } {
  const url = process.env.EVOLUTION_API_URL;
  const key = process.env.EVOLUTION_API_KEY;
  if (!url || !key) return { ok: false, state: "NOT_CONFIGURED" };
  return { ok: true, state: "CONFIGURED" };
}
