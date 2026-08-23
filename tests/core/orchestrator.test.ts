import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import type { BrainConfig } from "../../core/config/loader.ts";
import { routeQuery } from "../../core/orchestrator/router.ts";
import { buildContext } from "../../core/context/context-builder.ts";
import { ask } from "../../core/orchestrator/brain-orchestrator.ts";

let dir: string;
let vault: string;
let config: BrainConfig;

function write(relPath: string, content: string): void {
  const abs = path.join(vault, relPath.split("/").join(path.sep));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-orch-"));
  vault = path.join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  config = {
    vaultPath: vault,
    dataDir: dir,
    dbPath: path.join(dir, "brain.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };

  write(
    "01 - Projects/vyntra.md",
    `---
id: project.vyntra
type: project
title: Vyntra
status: active
aliases: [Vyntra CRM]
relations:
  - type: USES
    target: system.whatsapp-automation
  - type: HAS_DECISION
    target: decision.vyntra.campaigns
  - type: FOLLOWS
    target: procedure.deploy
---

# Vyntra

Plataforma de vendas com campanhas automatizadas via WhatsApp.
Palavra rara quilometrica para busca.`,
  );
  write(
    "03 - Knowledge/whatsapp-automation.md",
    `---
id: system.whatsapp-automation
type: system
title: WhatsApp Automation
status: stable
---
Sistema de automação de mensagens.`,
  );
  write(
    "05 - Decisions/campaigns.md",
    `---
id: decision.vyntra.campaigns
type: decision
title: Campanhas do Vyntra
status: accepted
related: [project.vyntra]
---
Decisão: usar sequências de campanha semanais.`,
  );
  write(
    "06 - Procedures/deploy.md",
    `---
id: procedure.deploy
type: procedure
title: Procedimento de Deploy
---
Passo a passo de deploy.`,
  );

  indexVault(config);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("orchestrator/router", () => {
  const cases: Array<[string, string, (p: ReturnType<typeof routeQuery>) => boolean]> = [
    ["quais projetos estão relacionados ao vyntra", "relationship", (p) => p.useGraph && !p.useSearch],
    ["qual foi a decisão sobre campanhas", "history", (p) => p.useTimeline && p.typeFilters.includes("decision")],
    ["o que é sales operating system", "concept", (p) => p.typeFilters.includes("knowledge")],
    ["como fazer deploy do clipcon", "procedure", (p) => p.typeFilters.includes("procedure")],
    ["vendas whatsapp", "general", (p) => p.useSearch && p.intent === "general"],
  ];
  for (const [query, expectedIntent, check] of cases) {
    it(`routes "${query}" → ${expectedIntent}`, () => {
      const plan = routeQuery(query);
      expect(plan.intent).toBe(expectedIntent);
      expect(check(plan)).toBe(true);
    });
  }
});

describe("context/context-builder", () => {
  it("builds full context for resolved entity", () => {
    const ctx = buildContext({
      dbPath: config.dbPath,
      subject: "Vyntra",
      depth: 1,
    });

    expect(ctx.entityId).toBe("project.vyntra");
    expect(ctx.resolvedBy).toBe("name");
    expect(ctx.status).toBe("active");
    expect(ctx.summary).toContain("Plataforma de vendas");
    expect(ctx.aliases).toContain("Vyntra CRM");

    const relatedIds = ctx.relatedEntities.map((r) => r.id);
    expect(relatedIds).toContain("system.whatsapp-automation");

    const decisionIds = ctx.decisions.map((d) => d.id);
    expect(decisionIds).toContain("decision.vyntra.campaigns");

    expect(ctx.documents.some((d) => d.path.includes("vyntra"))).toBe(true);
    expect(ctx.sources.length).toBeGreaterThan(0);
    expect(ctx.truncated).toBe(false);
    expect(ctx.charBudget.used).toBeLessThanOrEqual(ctx.charBudget.max);
  });

  it("deduplicates related entities", () => {
    const ctx = buildContext({ dbPath: config.dbPath, subject: "project.vyntra" });
    const ids = ctx.relatedEntities.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("respects char budget and reports truncation", () => {
    const ctx = buildContext({
      dbPath: config.dbPath,
      subject: "Vyntra",
      depth: 2,
      maxChars: 400,
    });
    expect(ctx.truncated).toBe(true);
    expect(ctx.warnings.join(" ")).toMatch(/truncado/i);
    expect(ctx.charBudget.used).toBeLessThanOrEqual(400);
  });

  it("falls back gracefully for unresolved subjects", () => {
    const ctx = buildContext({
      dbPath: config.dbPath,
      subject: "assunto-inexistente-zeta",
    });
    expect(ctx.entityId).toBeNull();
    expect(ctx.warnings.length).toBeGreaterThan(0);
    expect(Array.isArray(ctx.documents)).toBe(true);
  });

  it("rejects empty subject", () => {
    expect(() =>
      buildContext({ dbPath: config.dbPath, subject: "   " }),
    ).toThrowError(/empty/i);
  });
});

describe("orchestrator/ask", () => {
  it("routes relationship query and resolves entity", () => {
    const response = ask({
      dbPath: config.dbPath,
      query: "projetos relacionados ao vyntra",
    });

    expect(response.route.intent).toBe("relationship");
    expect(response.route.useGraph).toBe(true);
    expect(response.resolution?.entityId).toBe("project.vyntra");
    expect(response.context?.entityId).toBe("project.vyntra");
  });

  it("history query activates timeline sources", () => {
    const response = ask({
      dbPath: config.dbPath,
      query: "qual foi a decisão das campanhas do vyntra",
    });

    expect(response.route.useTimeline).toBe(true);
    expect(response.route.typeFilters).toContain("decision");
    const hits = response.searchHits.map((h) => h.documentId);
    expect(hits).toContain("decision.vyntra.campaigns");
  });

  it("dedupes search hits by document id", () => {
    const response = ask({ dbPath: config.dbPath, query: "vyntra" });
    const ids = response.searchHits.map((h) => h.documentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("handles unknown topics without crashing", () => {
    const response = ask({
      dbPath: config.dbPath,
      query: "zzztopico-desconhecido",
    });
    expect(response.context?.entityId ?? null).toBeNull();
    expect(response.searchHits).toHaveLength(0);
    expect(response.generatedAt).toBeTruthy();
  });
});
