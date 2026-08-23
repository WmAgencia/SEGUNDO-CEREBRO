import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import {
  createGoal,
  getGoal,
  updateGoal,
  listActiveGoalsByPriority,
  goalPriority,
} from "../../core/goals/goal-engine.ts";
import {
  addObservation,
  createOpportunity,
  createHypothesis,
} from "../../core/goals/funnel.ts";
import {
  createInitiative,
  getInitiative,
  listInitiatives,
  updateInitiativeStatus,
  scoreInitiative,
  planInitiative,
  approveInitiative,
  alignInitiative,
  formatProposal,
} from "../../core/goals/initiatives.ts";
import { brainNextActions } from "../../core/goals/proactive.ts";
import { unifiedQuery } from "../../core/unified.ts";
import { upsertAgent } from "../../core/agents/agent-runtime.ts";
import { indexSkillSource } from "../../core/skills/skill-engine.ts";

let dir: string;
let config: BrainConfig;

function db() {
  return new DatabaseSync(config.dbPath);
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-goals-"));
  config = {
    vaultPath: path.join(dir, "vault"),
    dataDir: dir,
    dbPath: path.join(dir, "brain.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };
  mkdirSync(config.vaultPath, { recursive: true });

  const notes: Array<[string, string]> = [
    ["vyntra.md", `---
id: project.vyntra
type: project
title: Vyntra
status: active
---
# Vyntra
Plataforma de vendas.`],
    ["campaigns.md", `---
id: decision.vyntra.campaigns
type: decision
title: Campanhas semanais
status: accepted
relations:
  - type: RELATED_TO
    target: project.vyntra
---
Sequencia D1 D3 D7.`],
    ["deploy.md", `---
id: procedure.deploy.vyntra
type: procedure
title: Deploy Vyntra
relations:
  - type: PART_OF
    target: project.vyntra
---
Deploy em passos.`],
  ];
  for (const [n, c] of notes) writeFileSync(path.join(config.vaultPath, n), c, "utf8");
  indexVault(config);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("fase 18 — goal & initiative engine", () => {
  let goalId: string;
  let observationId: number;
  let opportunityId: number;
  let hypothesisId: number;
  let initiativeId: string;

  it("18.1 cria goal com métrica e hierarquia", () => {
    const parent = createGoal(db(), {
      name: "Gerar caixa rapidamente",
      type: "FINANCIAL",
      status: "ACTIVE",
      priority: 1,
    });
    const child = createGoal(db(), {
      name: "Vender sites e sistemas",
      type: "SALES",
      status: "ACTIVE",
      priority: 2,
      parentGoalId: parent.id,
      metricName: "revenue",
      target: 10000,
      currentValue: 4000,
      projectId: "project.vyntra",
      deadline: new Date(Date.now() + 7 * 86400000).toISOString(),
    });
    expect(parent.id).toMatch(/^goal\.financial\./);
    expect(child.parentGoalId).toBe(parent.id);
    expect(child.progressPct).toBe(40);
    goalId = child.id;
  });

  it("18.1 atualiza goal (current value muda progresso)", () => {
    const updated = updateGoal(db(), goalId, { currentValue: 5000 });
    expect(updated.progressPct).toBe(50);
  });

  it("18.3 prioridade determinística explicável", () => {
    const g = getGoal(db(), goalId);
    const p = goalPriority(g);
    expect(p.reasons.length).toBeGreaterThan(2);
    expect(p.score).toBeGreaterThan(50);
    expect(goalPriority(g)).toEqual(p);
  });

  it("18.4 registra observação", () => {
    const obs = addObservation(db(), {
      type: "OPPORTUNITY_SIGNAL",
      source: "research",
      projectId: "project.vyntra",
      entityId: "project.vyntra",
      data: { title: "Psicólogos sem site", detalhe: "baixa presença digital" },
      confidence: 0.8,
      importance: 0.9,
    });
    expect(obs.obsType).toBe("OPPORTUNITY_SIGNAL");
    observationId = obs.id;
  });

  it("18.5 cria oportunidade ligada à observação", () => {
    const opp = createOpportunity(db(), {
      title: "Prospectar psicólogos com oferta de site",
      description: "Baixa presença digital = alta propensão",
      sourceObservationId: observationId,
      project: "project.vyntra",
      potentialImpact: 8,
      estimatedEffort: 3,
      risk: 2,
      confidence: 0.75,
    });
    opportunityId = opp.id;
    expect(opp.status).toBe("NEW");
  });

  it("18.6 cria hipótese (nunca tratada como fato)", () => {
    const h = createHypothesis(db(), {
      opportunityId,
      statement:
        "Se prospectarmos 100 psicólogos sem site com oferta de R$349,90, geramos ~10 oportunidades",
      evidence: ["observação de baixa presença digital"],
      confidence: 0.6,
      expectedOutcome: "10 conversas qualificadas",
      metricName: "qualified_leads",
      validationMethod: "campanha piloto 2 semanas",
    });
    hypothesisId = h.id;
    expect(h.statement.toLowerCase()).toContain("se ");
    expect(() =>
      createHypothesis(db(), { statement: "FATO: a terra é plana" }),
    ).toThrowError(/fato/i);
  });

  it("18.7-18.9 cria iniciativa, scoring determinístico e plano", () => {
    const init = createInitiative(db(), {
      title: "Prospecção de psicólogos",
      description: "Campanha para psicólogos sem site",
      goalId,
      project: "project.vyntra",
      hypothesisId,
      impact: 8,
      probability: 7,
      effort: 3,
      risk: 2,
      estimatedCost: 0,
      expectedOutcome: "3 clientes",
    });
    initiativeId = init.id;
    expect(init.status).toBe("DRAFT");

    const s1 = scoreInitiative(init);
    const s2 = scoreInitiative(init);
    expect(s1.score).toBe(s2.score);
    expect(s1.score).toBeGreaterThan(50);

    const tasks = planInitiative(db(), initiativeId);
    expect(tasks.length).toBeGreaterThanOrEqual(5);
    expect(tasks[1]?.dependsOn).not.toBeNull();

    expect(() => planInitiative(db(), initiativeId)).toThrowError(/já possui plano/i);
  });

  it("18.15-18.17 alinha agentes, skills e tools registrados", () => {
    const skillDir = path.join(dir, "skills-src", "cro");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: cro\ndescription: conversion rate optimization para campanhas e vendas\n---\nCRO",
      "utf8",
    );
    indexSkillSource(db(), {
      sourceId: "local-test",
      localPath: path.join(dir, "skills-src"),
    });

    const adb = db();
    upsertAgent(adb, {
      id: "marketing-agent",
      name: "Marketing Agent",
      domains: ["marketing", "vendas"],
      capabilities: ["copywriting", "cro", "campanhas"],
      permissions: ["context"],
    });
    adb.close();
    void dir;

    const alignment = alignInitiative(db(), config, initiativeId);
    expect(alignment.ownerAgent ?? "").toBeTruthy();
    expect(Array.isArray(alignment.tools)).toBe(true);
  });

  it("18.10-18.12 proposta formatada + aprovação humana explícita", () => {
    updateInitiativeStatus(db(), initiativeId, "AWAITING_APPROVAL");
    const proposal = formatProposal(db(), config, initiativeId);
    expect(proposal).toContain("NOVA INICIATIVA");
    expect(proposal).toContain("AGUARDANDO APROVAÇÃO");

    const approved = approveInitiative(db(), initiativeId, "humano");
    expect(approved.approvalStatus).toBe("APPROVED");
    expect(approved.status).toBe("APPROVED");
  });

  it("18.11 brain_next_actions recomenda com motivos", () => {
    const na = brainNextActions(config);
    expect(na.goals.length).toBeGreaterThan(0);
    expect(na.recommendations.length).toBeGreaterThan(0);
    for (const r of na.recommendations) {
      expect(r.reason.length).toBeGreaterThan(5);
    }
  });

  it("18.18 brain_query integrado expõe goals/nextActions", () => {
    const pre = db().prepare("SELECT status, COUNT(*) AS c FROM goals GROUP BY status").all();
    console.error("DEBUG goals:", JSON.stringify(pre));
    const res = unifiedQuery(config, {
      query: "O que deveríamos fazer agora para vender mais?",
    });
    expect(res.nextActions).not.toBeNull();
    expect((res.nextActions?.goals ?? []).length).toBeGreaterThan(0);
    expect(res.nextActions?.recommendations.length ?? 0).toBeGreaterThan(0);
  });
});
