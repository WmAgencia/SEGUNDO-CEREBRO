import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../../core/config/loader.ts";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import {
  getProjectIntelligence,
} from "../../core/projects/project-intelligence.ts";

let dir: string;
let config: BrainConfig;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-proj-"));
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
  - type: IMPLEMENTS
    target: concept.sos
  - type: HAS_DECISION
    target: decision.vyntra.campaigns
  - type: RELATED_TO
    target: project.prospector
---
# Vyntra
Plataforma de vendas.`],
    ["sos.md", `---
id: concept.sos
type: concept
title: Sales OS
---
Conceito base.`],
    ["campaigns.md", `---
id: decision.vyntra.campaigns
type: decision
title: Campanhas semanais
status: accepted
---
Decisao de campanha.`],
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
  ];
  for (const [name, content] of notes) {
    writeFileSync(path.join(config.vaultPath, name), content, "utf8");
  }
  indexVault(config);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("project intelligence (fase 16)", () => {
  it("aggregates decisions, relations and cross-project links", () => {
    const pi = getProjectIntelligence(config, "project.vyntra");
    expect(pi.entity.id).toBe("project.vyntra");
    expect(pi.decisions.map((d) => d.id)).toContain("decision.vyntra.campaigns");
    expect(pi.projectRelations.some((r) => r.otherProject === "project.prospector")).toBe(true);
    expect(Object.keys(pi.relatedByType).length).toBeGreaterThan(0);
    expect(pi.timeline.length).toBeGreaterThan(0);
  });

  it("resolves by name and rejects non-project entities", () => {
    const byName = getProjectIntelligence(config, "Vyntra");
    expect(byName.entity.id).toBe("project.vyntra");

    expect(() => getProjectIntelligence(config, "concept.sos")).toThrowError(
      /projeto não encontrado|não encontrado/i,
    );
  });
});
