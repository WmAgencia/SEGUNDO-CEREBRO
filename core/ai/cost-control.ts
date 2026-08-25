import { DatabaseSync } from "node:sqlite";

/**
 * COST CONTROL (spec §33) — soma custo LLM do dia e enforce budget.
 * model_generations.cost é preenchido pelo gateway quando o provider informa.
 */

export class BudgetExceededError extends Error {
  readonly spentToday: number;
  readonly limit: number;
  constructor(spentToday: number, limit: number) {
    super(`budget diário de LLM excedido: US$${spentToday.toFixed(4)} ≥ US$${limit.toFixed(2)} — pause e peça aprovação`);
    this.name = "BudgetExceededError";
    this.spentToday = spentToday;
    this.limit = limit;
  }
}

/** Custo total (US$) registrado hoje em model_generations. */
export function getDailyLlmCost(db: DatabaseSync, now: Date = new Date()): number {
  const day = now.toISOString().slice(0, 10);
  const row = db.prepare(
    "SELECT COALESCE(SUM(cost),0) AS c FROM model_generations WHERE substr(created_at,1,10)=?",
  ).get(day) as { c: number | null };
  return row.c ?? 0;
}

export interface BudgetCheck {
  ok: boolean;
  spentToday: number;
  limitPerDay: number;
}

/**
 * Verifica budget diário. Limite via arg ou env SECOND_BRAIN_DAILY_COST_LIMIT (US$).
 * Sem limite configurado → sempre ok (comportamento atual preservado).
 */
export function checkDailyBudget(
  db: DatabaseSync,
  opts: { limitUsd?: number; now?: Date } = {},
): BudgetCheck {
  const envLimit = Number(process.env.SECOND_BRAIN_DAILY_COST_LIMIT ?? "");
  const limitPerDay = opts.limitUsd ?? (Number.isFinite(envLimit) && envLimit > 0 ? envLimit : 0);
  const spentToday = getDailyLlmCost(db, opts.now ?? new Date());
  if (limitPerDay <= 0) return { ok: true, spentToday, limitPerDay: 0 };
  return { ok: spentToday < limitPerDay, spentToday, limitPerDay };
}
