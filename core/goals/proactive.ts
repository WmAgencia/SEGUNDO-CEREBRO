import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { listActiveGoalsByPriority } from "./goal-engine.ts";
import { listObservations } from "./funnel.ts";
import { listInitiatives, scoreInitiative } from "./initiatives.ts";

export interface NextActionRecommendation {
  kind: "goal" | "observation" | "opportunity" | "initiative";
  ref: string;
  title: string;
  reason: string;
}

export interface NextActionsResult {
  goals: Array<{ id: string; name: string; progressPct: number | null; score: number; reasons: string[] }>;
  observations: ReturnType<typeof listObservations>;
  opportunities: Array<{ id: number; title: string; status: string }>;
  initiatives: Array<{ id: string; title: string; status: string; approvalStatus: string; score: number | null }>;
  recommendations: NextActionRecommendation[];
  generatedAt: string;
}

const PROACTIVE_RE = /o que (dever(í|i)amos|devemos|posso) fazer|pr(ó|o)xim(a|os) passos?|what should we do/i;

export function isProactiveQuery(query: string): boolean {
  return PROACTIVE_RE.test(query);
}

export function brainNextActions(config: BrainConfig): NextActionsResult {
  const db = new DatabaseSync(config.dbPath);
  try {
    const goals = listActiveGoalsByPriority(db, 5);
    const observations = listObservations(db, { limit: 10 });
    const initiatives = listInitiatives(db).filter(
      (i) => i.status === "AWAITING_APPROVAL" || i.status === "APPROVED" || i.status === "PROPOSED",
    );

    const scored = initiatives
      .map((i) => ({ initiative: i, ...scoreInitiative(i) }))
      .sort((a, b) => b.score - a.score);

    const recommendations: NextActionRecommendation[] = [];

    for (const g of goals.slice(0, 2)) {
      recommendations.push({
        kind: "goal",
        ref: g.id,
        title: g.name,
        reason: `objetivo ativo priorizado (${g.score} pts): ${g.reasons[0] ?? "sem detalhes"}`,
      });
    }

    const openOpps = observations.filter((o) =>
      ["OPPORTUNITY_SIGNAL", "PROBLEM", "METRIC_CHANGE"].includes(o.obsType),
    );
    for (const o of openOpps.slice(0, 3)) {
      recommendations.push({
        kind: "observation",
        ref: String(o.id),
        title: o.data.title ? String(o.data.title) : `${o.obsType}`,
        reason: `observação ${o.obsType} com importância ${o.importance}`,
      });
    }

    for (const s of scored.slice(0, 3)) {
      if (s.initiative.approvalStatus === "PENDING") {
        recommendations.push({
          kind: "initiative",
          ref: s.initiative.id,
          title: s.initiative.title,
          reason: `aguardando aprovação — score ${s.score}/100`,
        });
      }
    }

    return {
      goals: goals.map((g) => ({
        id: g.id,
        name: g.name,
        progressPct: g.progressPct,
        score: g.score,
        reasons: g.reasons,
      })),
      observations,
      opportunities: [],
      initiatives: scored.map((s) => ({
        id: s.initiative.id,
        title: s.initiative.title,
        status: s.initiative.status,
        approvalStatus: s.initiative.approvalStatus,
        score: s.score,
      })),
      recommendations,
      generatedAt: new Date().toISOString(),
    };
  } finally {
    db.close();
  }
}
