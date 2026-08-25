import { DatabaseSync } from "node:sqlite";
import type { ProspectingSource, LeadCandidate } from "../agents/specialized.ts";
import { saveLead, leadStats, listLeads } from "./leads.ts";

export interface ProspectionConfig {
  /** Janela operacional (horas 0-23). Suporta janela virando o dia: 23 → 07. */
  windowStartHour: number;
  windowEndHour: number;
  maxLeadsPerDay: number;
  requestBudgetPerCycle: number;
  minScoreToQueue: number;
}

export const DEFAULT_PROSPECTION_CONFIG: ProspectionConfig = {
  windowStartHour: Number(process.env.PROSPECTION_WINDOW_START ?? "23"),
  windowEndHour: Number(process.env.PROSPECTION_WINDOW_END ?? "7"),
  maxLeadsPerDay: Number(process.env.PROSPECTION_MAX_LEADS_PER_DAY ?? "100"),
  requestBudgetPerCycle: Number(process.env.PROSPECTION_REQUEST_BUDGET ?? "20"),
  minScoreToQueue: Number(process.env.PROSPECTION_MIN_SCORE ?? "40"),
};

/** Deterministic window check. Supports overnight windows (e.g. 23 → 07). */
export function isWithinWindow(hour: number, config: ProspectionConfig): boolean {
  if (!Number.isFinite(hour) || hour < 0 || hour > 23) return false;
  const { windowStartHour: s, windowEndHour: e } = config;
  if (s === e) return true; // 24h window
  if (s < e) return hour >= s && hour < e;
  return hour >= s || hour < e; // overnight
}

export interface CycleReport {
  status: "RAN" | "OUTSIDE_WINDOW" | "DAILY_BUDGET_REACHED" | "KILL_SWITCH_ACTIVE" | "NO_SOURCES_AVAILABLE";
  startedAt: string;
  finishedAt?: string;
  leadsSaved: number;
  duplicatesBlocked: number;
  blockedSources: Array<{ source: string; reason: string }>;
  qualifiedForApproach: string[];
}

interface SourceAttempt { name: string; ok: boolean; error?: string }

/** Contador determinístico de uso diário (sobrevive a datas simuladas/testes). */
const dailyKey = (day: string): string => `prospection.daily.${day}`;

function getDailyCount(db: DatabaseSync, day: string): number {
  const row = db.prepare("SELECT data FROM working_memory WHERE task_key=?").get(dailyKey(day)) as
    | { data: string }
    | undefined;
  if (!row) return 0;
  try {
    const parsed = JSON.parse(row.data) as { count?: number };
    return typeof parsed.count === "number" ? parsed.count : 0;
  } catch {
    return 0;
  }
}

function bumpDailyCount(db: DatabaseSync, day: string, delta: number): void {
  const next = getDailyCount(db, day) + delta;
  const existing = db.prepare("SELECT id FROM working_memory WHERE task_key=?").get(dailyKey(day)) as
    | { id: number }
    | undefined;
  if (existing?.id) {
    db.prepare("UPDATE working_memory SET data=? WHERE id=?").run(JSON.stringify({ count: next }), existing.id);
  } else {
    db.prepare("INSERT INTO working_memory (task_key,data) VALUES (?,?)").run(dailyKey(day), JSON.stringify({ count: next }));
  }
}

/**
 * Runs one prospection cycle against authorized/technically-accessible sources.
 * Sources that are not configured (missing API key) or that block automation
 * are recorded as BLOCKED_SOURCE and the cycle continues with remaining sources.
 * NEVER bypasses captcha/login/security mechanisms — a blocked source is skipped.
 */
export async function runProspectionCycle(
  db: DatabaseSync,
  sources: ProspectingSource[],
  query: string,
  options: Partial<ProspectionConfig> & { now?: Date; killSwitchActive?: boolean; requestCostPerSearch?: number } = {},
): Promise<CycleReport> {
  const config = { ...DEFAULT_PROSPECTION_CONFIG, ...options };
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const report: CycleReport = {
    status: "RAN", startedAt, leadsSaved: 0, duplicatesBlocked: 0, blockedSources: [], qualifiedForApproach: [],
  };

  if (options.killSwitchActive) {
    report.status = "KILL_SWITCH_ACTIVE";
    return finish(report);
  }
  if (!isWithinWindow(now.getHours(), config)) {
    report.status = "OUTSIDE_WINDOW";
    return finish(report);
  }

  // Daily budget: contador determinístico por dia simulado (independe do relógio).
  const day = startedAt.slice(0, 10);
  const todayCount = getDailyCount(db, day);
  if (todayCount >= config.maxLeadsPerDay) {
    report.status = "DAILY_BUDGET_REACHED";
    return finish(report);
  }
  let remainingBudget = Math.min(
    config.maxLeadsPerDay - todayCount,
    Math.ceil(config.requestBudgetPerCycle / (options.requestCostPerSearch ?? 1)),
  );

  let usableSources = 0;
  for (const source of sources) {
    if (remainingBudget <= 0) break;
    const attempt: SourceAttempt = { name: source.name, ok: false };
    try {
      const candidates: LeadCandidate[] = await source.search(query);
      usableSources++;
      attempt.ok = true;
      for (const c of candidates.slice(0, Math.floor(remainingBudget))) {
        const result = saveLead(db, {
          companyName: c.company,
          contactName: c.contact ?? undefined,
          website: c.website ?? undefined,
          source: c.source,
          sourceUrl: c.source,
          category: c.niche ?? undefined,
          city: c.location ?? undefined,
          signals: c.signals,
          evidence: c.evidence,
        });
        if (result.saved) {
          report.leadsSaved++;
          remainingBudget--;
          if (result.lead.qualificationScore >= config.minScoreToQueue) {
            report.qualifiedForApproach.push(result.lead.id);
          }
        } else {
          report.duplicatesBlocked++;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      attempt.error = msg;
      // Fonte sem credencial ou que bloqueou automação → registrada e pulada.
      report.blockedSources.push({ source: source.name, reason: msg });
    }
  }
  if (report.leadsSaved > 0) bumpDailyCount(db, day, report.leadsSaved);

  if (usableSources === 0 && report.leadsSaved === 0) {
    report.status = "NO_SOURCES_AVAILABLE";
  }
  return finish(report);
}

function finish(r: CycleReport): CycleReport {
  r.finishedAt = new Date().toISOString();
  return r;
}

/** Queue leads for commercial approach (status transition only — no auto-send). Accepts NEW or QUALIFIED leads. */
export function queueLeadsForCommercial(db: DatabaseSync, leadIds: string[], assignedAgent?: string): number {
  let queued = 0;
  for (const id of leadIds) {
    const res = db.prepare(
      "UPDATE leads SET status='APPROACH_QUEUED', assigned_agent=COALESCE(?, assigned_agent), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND status IN ('NEW','QUALIFIED')",
    ).run(assignedAgent ?? null, id);
    queued += Number(res.changes ?? 0);
  }
  return queued;
}

export function prospectionSummary(db: DatabaseSync): string {
  const stats = leadStats(db);
  const top = listLeads(db, { minScore: 40, limit: 5 })
    .map((l) => `${l.companyName} (${l.qualificationScore}pts, ${l.source})`).join("; ");
  return `Leads: ${stats.total} total, ${stats.qualified} qualificados, ${stats.queued} na fila comercial.${top ? ` Top: ${top}.` : ""}`;
}
