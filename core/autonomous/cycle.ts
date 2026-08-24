import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { listActiveGoalsByPriority } from "../goals/goal-engine.ts";
import { generateProactiveProposals } from "../proactive/proactive-engine.ts";
import type { ProactiveProposal } from "../proactive/proactive-engine.ts";
import { redactSecrets } from "../exec/redact.ts";

export interface AutonomousCycle {
  id: number;
  goalId: string | null;
  status: "RUNNING" | "COMPLETED" | "BLOCKED" | "FAILED";
  startedAt: string;
  endedAt: string | null;
  observation: string;
  analysis: string;
  actionsTaken: string[];
  learnings: string[];
}

export function runAutonomousCycle(
  config: BrainConfig,
): AutonomousCycle {
  if (globalKillSwitch) {
    return skipped("kill_switch_active");
  }

  const startedAt = new Date().toISOString();
  const db = new DatabaseSync(config.dbPath);
  try {
    // 1. OBSERVE
    const goals = listActiveGoalsByPriority(db, 5);
    const proposals = generateProactiveProposals(config);

    if (goals.length === 0 && proposals.length === 0) {
      return finishCycle(db, {
        goalId: null,
        observation: "nenhum objetivo ativo ou proposta detectada",
        analysis: "nada a fazer neste ciclo",
        actionsTaken: [],
        learnings: [],
      });
    }

    // 2. ANALYZE + PRIORITIZE
    const topGoal = goals[0];
    const topProposal = proposals[0];
    const observation = topProposal
      ? `proposal: ${topProposal.title} (priority=${topProposal.priority})`
      : `goal: ${topGoal?.name ?? "none"}`;

    const analysis = [
      `objetivos ativos: ${goals.length}`,
      `propostas proativas: ${proposals.length}`,
      topGoal ? `goal prioritário: ${topGoal.name} (score=${topGoal.score})` : "",
      topProposal ? `proposta prioritária: ${topProposal.title}` : "",
    ].filter(Boolean).join("; ");

    // 3. ACTIONS (deterministic, within policy)
    const actions: string[] = [];
    const learnings: string[] = [];

    if (topGoal) {
      db.prepare(
        `INSERT INTO events (event_type, subject, payload)
         VALUES ('autonomous_cycle_goal_observed', ?, ?)`,
      ).run(topGoal.id, JSON.stringify({ score: topGoal.score, progress: topGoal.progressPct }));
      actions.push(`observou objetivo "${topGoal.name}"`);
    }

    if (topProposal) {
      db.prepare(
        `INSERT INTO events (event_type, subject, payload)
         VALUES ('autonomous_proposal_generated', ?, ?)`,
      ).run(topProposal.objective, JSON.stringify({
        title: topProposal.title,
        priority: topProposal.priority,
        reason: topProposal.reason,
      }));
      actions.push(`gerou proposta "${topProposal.title.slice(0, 60)}"`);
      learnings.push(`padrão detectado: ${topProposal.reason}`);
    }

    // 4. REPORT TO SECOM
    try {
      const evoUrl = process.env.EVOLUTION_API_URL;
      const evoKey = process.env.EVOLUTION_API_KEY;
      const evoInstance = process.env.EVOLUTION_INSTANCE ?? "SECOM";
      if (evoUrl && evoKey) {
        const summary = [
          "🧠 AUTONOMOUS CYCLE",
          "",
          topGoal ? `Objetivo: ${topGoal.name}` : "",
          topProposal ? `Proposta: ${topProposal.title}` : "",
          `Ações: ${actions.length}`,
          "",
          `Motivo: ${analysis}`,
        ].filter(Boolean).join("\n");
        const body = JSON.stringify({
          number: process.env.SECOND_BRAIN_OPERATIONS_GROUP ?? "120363427273069174@g.us",
          text: redactSecrets(summary),
        });
        fetch(`${evoUrl}/message/sendText/${evoInstance}`, {
          method: "POST",
          headers: { apikey: evoKey, "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(15000),
        }).catch(() => {});
      }
    } catch {}

    return finishCycle(db, {
      goalId: topGoal?.id ?? null,
      observation,
      analysis,
      actionsTaken: actions,
      learnings,
    });
  } finally {
    db.close();
  }
}

function finishCycle(
  db: DatabaseSync,
  data: {
    goalId: string | null;
    observation: string;
    analysis: string;
    actionsTaken: string[];
    learnings: string[];
  },
): AutonomousCycle {
  const endedAt = new Date().toISOString();
  db.prepare(
    `INSERT INTO events (event_type, subject, payload) VALUES ('autonomous_cycle_completed', ?, ?)`,
  ).run(data.goalId ?? "system", JSON.stringify(data));
  return {
    id: Number((db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id),
    goalId: data.goalId,
    status: data.actionsTaken.length > 0 ? "COMPLETED" : "BLOCKED",
    startedAt: endedAt,
    endedAt,
    observation: data.observation,
    analysis: data.analysis,
    actionsTaken: data.actionsTaken,
    learnings: data.learnings,
  };
}

function skipped(reason: string): AutonomousCycle {
  return {
    id: 0, goalId: null, status: "BLOCKED",
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString(),
    observation: reason, analysis: "", actionsTaken: [], learnings: [],
  };
}

function isKillSwitchActive(_db: DatabaseSync): boolean {
  return globalKillSwitch;
}

let globalKillSwitch = false;

export function setKillSwitch(active: boolean): void {
  globalKillSwitch = active;
}
