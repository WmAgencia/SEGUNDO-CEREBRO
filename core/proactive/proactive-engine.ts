import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import {
  listActiveGoalsByPriority,
} from "../goals/goal-engine.ts";
import {
  addObservation,
  createOpportunity,
  listObservations,
} from "../goals/funnel.ts";
import { listInitiatives } from "../goals/initiatives.ts";

export interface ProactiveProposal {
  title: string;
  objective: string;
  reason: string;
  evidence: string[];
  expectedImpact: string;
  cost: string;
  effort: string;
  risk: string;
  confidence: number;
  recommendedAction: string;
  priority: "URGENT" | "HIGH" | "MEDIUM" | "LOW";
  requiredAgents: string[];
  requiredTools: string[];
  approvalRequired: boolean;
}

export interface DailyDigest {
  goals: Array<{ name: string; progressPct: number | null; score: number }>;
  opportunities: number;
  blockedTasks: number;
  pendingApprovals: number;
  recentMemories: number;
  recommendations: string[];
}

export function generateProactiveProposals(
  config: BrainConfig,
): ProactiveProposal[] {
  const db = new DatabaseSync(config.dbPath);
  try {
    const proposals: ProactiveProposal[] = [];

    const goals = listActiveGoalsByPriority(db, 5);
    for (const goal of goals) {
      if (goal.progressPct !== null && goal.progressPct < 30 && goal.score > 60) {
        proposals.push({
          title: `Objetivo "${goal.name}" está abaixo do ritmo`,
          objective: goal.id,
          reason: `${goal.progressPct}% de progresso com score de prioridade ${goal.score}`,
          evidence: [`score=${goal.score}`, `progresso=${goal.progressPct}%`],
          expectedImpact: "alto se acelerado",
          cost: "R$0 (análise)",
          effort: "médio",
          risk: "baixo",
          confidence: 0.7,
          recommendedAction: "Revisar estratégia e criar iniciativa de aceleração",
          priority: "HIGH",
          requiredAgents: [],
          requiredTools: [],
          approvalRequired: false,
        });
      }
      if (goal.deadline) {
        const daysLeft = Math.ceil((Date.parse(goal.deadline) - Date.now()) / 86400000);
        if (daysLeft <= 7 && daysLeft > 0) {
          proposals.push({
            title: `"${goal.name}" vence em ${daysLeft} dias`,
            objective: goal.id,
            reason: `prazo em ${daysLeft} dias`,
            evidence: [`deadline=${goal.deadline}`],
            expectedImpact: "urgente",
            cost: "R$0 (alerta)",
            effort: "baixo",
            risk: "baixo",
            confidence: 0.95,
            recommendedAction: "Priorizar tarefas deste objetivo imediatamente",
            priority: "URGENT",
            requiredAgents: [],
            requiredTools: [],
            approvalRequired: false,
          });
        }
      }
    }

    const observations = listObservations(db, { type: "OPPORTUNITY_SIGNAL", limit: 5 });
    for (const obs of observations) {
      const data = obs.data as Record<string, unknown>;
      if (typeof data.title === "string") {
        proposals.push({
          title: `Oportunidade: ${data.title}`,
          objective: "novo",
          reason: `sinal OPPORTUNITY_SIGNAL com importância ${obs.importance}`,
          evidence: [JSON.stringify(data).slice(0, 200)],
          expectedImpact: "potencial",
          cost: "R$0",
          effort: "a avaliar",
          risk: "a avaliar",
          confidence: obs.confidence,
          recommendedAction: "Avaliar viabilidade e criar iniciativa se promissor",
          priority: "MEDIUM",
          requiredAgents: [],
          requiredTools: [],
          approvalRequired: false,
        });
      }
    }

    return proposals.sort((a, b) => {
      const order = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      return (order[a.priority] ?? 9) - (order[b.priority] ?? 9);
    });
  } finally {
    db.close();
  }
}

export function generateDailyDigest(config: BrainConfig): DailyDigest {
  const db = new DatabaseSync(config.dbPath);
  try {
    const goals = listActiveGoalsByPriority(db, 10).map((g) => ({
      name: g.name,
      progressPct: g.progressPct,
      score: g.score,
    }));

    const counts = db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM opportunities WHERE status IN ('NEW','ANALYZING')) AS opportunities,
        (SELECT COUNT(*) FROM initiative_tasks WHERE status='BLOCKED') AS blockedTasks,
        (SELECT COUNT(*) FROM approvals WHERE status='PENDING') AS pendingApprovals,
        (SELECT COUNT(*) FROM memories WHERE created_at >= date('now','-1 day')) AS recentMemories`,
    ).get() as Record<string, number>;

    const recommendations = generateProactiveProposals(config)
      .slice(0, 3)
      .map((p) => p.title);

    return {
      goals,
      opportunities: counts.opportunities ?? 0,
      blockedTasks: counts.blockedTasks ?? 0,
      pendingApprovals: counts.pendingApprovals ?? 0,
      recentMemories: counts.recentMemories ?? 0,
      recommendations,
    };
  } finally {
    db.close();
  }
}
