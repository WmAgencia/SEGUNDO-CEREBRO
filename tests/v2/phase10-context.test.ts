import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import type { BrainConfig } from "../../core/config/loader.ts";
import { buildContextPackage } from "../../core/context/context-package.ts";

let dir: string;
let config: BrainConfig;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-ctxp-"));
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
  writeFileSync(
    path.join(config.vaultPath, "vyntra.md"),
    `---
id: project.vyntra
type: project
title: Vyntra
status: active
relations:
  - type: HAS_DECISION
    target: decision.vyntra.campaigns
---
# Vyntra
Plataforma de vendas.`,
    "utf8",
  );
  writeFileSync(
    path.join(config.vaultPath, "campaigns.md"),
    `---
id: decision.vyntra.campaigns
type: decision
title: Campanhas do Vyntra
status: accepted
related: [project.vyntra]
---
Decisao de campanhas.`,
    "utf8",
  );
  indexVault(config);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("context package (fase 10)", () => {
  it("builds package for real task", () => {
    const pkg = buildContextPackage(config, {
      task: "Preciso trabalhar no Vyntra",
      depth: 1,
    });
    expect(pkg.entities).toContain("project.vyntra");
    expect(pkg.context.status).toBe("active");
    expect(Array.isArray(pkg.memories)).toBe(true);
    expect(Array.isArray(pkg.relationships)).toBe(true);
    expect(pkg.warnings).not.toContain(
      "nenhuma entidade resolvida para esta tarefa",
    );
  });

  it("includes decisions when they exist for the entity", () => {
    const pkg = buildContextPackage(config, { task: "trabalhar no Vyntra" });
    expect(pkg.decisions.some((d) => d.id === "decision.vyntra.campaigns")).toBe(true);
  });

  it("rejects empty task", () => {
    expect(() =>
      buildContextPackage(config, { task: "" }),
    ).toThrowError(/task is required/i);
  });
});
