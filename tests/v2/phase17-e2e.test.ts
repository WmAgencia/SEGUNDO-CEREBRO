import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../../core/config/loader.ts";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import { unifiedQuery } from "../../core/unified.ts";
import {
  listCandidates,
  observe,
  acceptObservation,
} from "../../core/learning/learning-loop.ts";
import { createMemory } from "../../core/memory/memory-engine.ts";
import { upsertAgent } from "../../core/agents/agent-runtime.ts";
import { seedBrainTools } from "../../core/tools/tool-registry.ts";
import { indexSkillSource } from "../../core/skills/skill-engine.ts";
import { getProjectIntelligence } from "../../core/projects/project-intelligence.ts";

let dir: string;
let config: BrainConfig;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-e2e-"));
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
relations:
  - type: HAS_DECISION
    target: decision.vyntra.campaigns
  - type: RELATED_TO
    target: project.prospector
---
# Vyntra
Plataforma de vendas com campanhas.`],
    ["campaigns.md", `---
id: decision.vyntra.campaigns
type: decision
title: Campanhas semanais
status: accepted
---
Sequencia D1 D3 D7.`],
    ["prospector.md", `---
id: project.prospector
type: project
title: Prospector
status: active
relations:
  - type: RELATED_TO
    target: project.vyntra
---
# Prospector
Prospeccao B2B.`],
    ["deploy.md", `---
id: procedure.deploy
type: procedure
title: Deploy Vyntra
---
Passo a passo de deploy.`],
  ];
  for (const [n, c] of notes) {
    writeFileSync(path.join(config.vaultPath, n), c, "utf8");
  }
  indexVault(config);

  // skills fake locais
  const skillDir = path.join(dir, "skills", "cro");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: cro\ndescription: melhorar conversao de vendas e campanhas\n---\nCRO",
    "utf8",
  );
  indexSkillSource(db(), {
    sourceId: "local-test",
    localPath: path.join(dir, "skills"),
  });
  seedBrainTools(db());

  // agente
  upsertAgent(db(), {
    id: "sales-agent",
    name: "Sales Agent",
    description: "agente de vendas",
    domains: ["vendas", "vyntra"],
    permissions: ["context"],
  });
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

function db() {
  return new DatabaseSync(config.dbPath);
}

describe("fase 17 — unified personal os", () => {
  it("end-to-end: projeto → contexto → memórias → decisões → skills → tools → agentes", () => {
    // aprendizado prévio aceito vira memória
    const obs = observe(db(), {
      observationType: "user_correction",
      subject: "campanhas seguem sempre D1 D3 D7 sem alteracao",
      patternKey: "correcao cadencia campanhas",
      threshold: 2,
    });
    if (!obs.isCandidate) {
      observe(db(), {
        observationType: "user_correction",
        subject: "cadencia fixa",
        patternKey: "correcao cadencia campanhas",
        threshold: 2,
      });
    }
    const candidate = listCandidatesSafe().find((c) => c.status === "candidate");
    expect(candidate).toBeDefined();
    acceptObservation(db(), candidate!.id);
    createMemory(db(), {
      content: "Cadencia de campanhas do Vyntra é fixa: D1 D3 D7",
      memoryKind: "semantic",
      category: "PREFERENCE",
      entityId: "project.vyntra",
      confidence: 0.9,
    });

    const res = unifiedQuery(config, {
      query: "Preciso trabalhar no Vyntra para melhorar as vendas",
      depth: 2,
    });

    expect(res.intent).toBe("general");
    expect(res.entities).toContain("project.vyntra");
    expect(res.decisions.some((d) => d.id === "decision.vyntra.campaigns")).toBe(true);
    expect(res.memories.length).toBeGreaterThan(0);
    expect(res.skills.primary.length).toBeGreaterThan(0);
    expect(Array.isArray(res.tools)).toBe(true);
    expect(res.agents.some((a) => a.id === "sales-agent")).toBe(true);
    expect(res.sources.length).toBeGreaterThan(0);
  });

  it("project intelligence works alongside unified query", () => {
    const pi = getProjectIntelligence(config, "vyntra");
    expect(pi.projectRelations.some((r) => r.otherProject === "project.prospector")).toBe(true);
  });

  it("logs unified queries into events", () => {
    unifiedQuery(config, { query: "trabalhar no prospector" });
    const rows = db()
      .prepare("SELECT COUNT(*) AS c FROM events WHERE event_type = 'unified.query'")
      .get() as { c: number };
    expect(rows.c).toBeGreaterThanOrEqual(2);
  });
});

function listCandidatesSafe() {
  return listCandidates(db()) as Array<{ id: number; status: string; observationType: string }>;
}
