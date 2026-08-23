import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import { searchDocuments } from "../../core/retrieval/searcher.ts";
import { sanitizeFtsQuery } from "../../core/retrieval/fts-query.ts";

let dir: string;
let vault: string;
let dbPath: string;

function write(relPath: string, content: string): void {
  const abs = path.join(vault, relPath.split("/").join(path.sep));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-search-"));
  vault = path.join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  dbPath = path.join(dir, "brain.db");

  write(
    "01 - Projects/vyntra.md",
    `---
id: project.vyntra
type: project
title: Vyntra
tags: [vendas]
---
# Vyntra
Plataforma de vendas com WhatsApp automation e campanhas.`,
  );
  write(
    "01 - Projects/prospector.md",
    `---
id: project.prospector
type: project
title: Prospector
tags: [vendas, prospeccao]
---
# Prospector
Ferramenta de prospecção para times comerciais de vendas.`,
  );
  write(
    "03 - Knowledge/vendas.md",
    `---
id: concept.sales-operating-system
type: concept
title: Sales Operating System
aliases: [SOS Comercial]
tags: [conceito]
---
# SOS
Sistema operacional de vendas: processo, métricas e rotinas.`,
  );
  write(
    "03 - Knowledge/generico.md",
    `---
id: knowledge.generico
title: Nota Genérica
---
Conteúdo sem relação com os termos principais de teste.`,
  );

  indexVault({
    vaultPath: vault,
    dataDir: dir,
    dbPath,
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  });
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function search(query: string, filters?: Parameters<typeof searchDocuments>[0]["filters"], limit?: number) {
  return searchDocuments({ dbPath, query, filters, limit });
}

describe("retrieval/fts-query sanitizer", () => {
  it("quotes tokens and joins with AND", () => {
    const q = sanitizeFtsQuery('vyntra "whatsapp" OR (campanhas)');
    expect(q.tokens).toEqual(["vyntra", "whatsapp", "OR", "campanhas"]);
    expect(q.andQuery).toBe('"vyntra"* AND "whatsapp"* AND "OR"* AND "campanhas"*');
  });

  it("rejects empty queries", () => {
    expect(() => sanitizeFtsQuery("   ")).toThrowError(/empty/i);
    expect(() => sanitizeFtsQuery("!!! ###")).toThrowError(/no searchable terms/i);
  });

  it("handles accented and unicode tokens", () => {
    const q = sanitizeFtsQuery("prospecção campanhas");
    expect(q.tokens).toContain("prospecção");
  });
});

describe("retrieval/searcher", () => {
  it("finds exact term with entity enrichment", () => {
    const result = search("vyntra");
    expect(result.total).toBeGreaterThanOrEqual(1);
    const hit = result.hits.find((h) => h.documentId === "project.vyntra");
    expect(hit).toBeDefined();
    expect(hit?.entities.some((e) => e.id === "project.vyntra")).toBe(true);
    expect(hit?.snippet.toLowerCase()).toContain("[vyntra]");
    expect(hit?.sourceType).toBe("obsidian");
  });

  it("matches partial words via prefix", () => {
    const result = search("vyn");
    expect(result.hits.some((h) => h.documentId === "project.vyntra")).toBe(true);
  });

  it("ranks docs matching more terms higher (AND strategy)", () => {
    const result = search("vendas whatsapp");
    expect(result.strategy).toBe("and");
    expect(result.hits[0]?.documentId).toBe("project.vyntra");
  });

  it("falls back to OR when AND has no results", () => {
    const result = search("vyntra prospecçaozz");
    expect(result.strategy).toBe("or");
    expect(result.total).toBeGreaterThanOrEqual(1);
  });

  it("filters by type", () => {
    const onlyProjects = search("vendas", { type: ["project"] });
    expect(onlyProjects.total).toBe(2);
    expect(onlyProjects.hits.every((h) => h.type === "project")).toBe(true);

    const onlyConcepts = search("vendas", { type: ["concept"] });
    expect(onlyConcepts.hits.map((h) => h.documentId)).toContain(
      "concept.sales-operating-system",
    );
  });

  it("filters by tag", () => {
    const result = search("comerciais", { tag: "prospeccao" });
    expect(result.hits.map((h) => h.documentId)).toEqual(["project.prospector"]);
  });

  it("filters by path prefix", () => {
    const result = search("vendas", { pathPrefix: "01 - Projects" });
    expect(result.total).toBe(2);
    expect(result.hits.every((h) => h.path.startsWith("01 - Projects"))).toBe(true);
  });

  it("paginates with limit and offset", () => {
    const page1 = search("vendas", undefined, 1);
    const all = search("vendas", undefined, 50);
    expect(page1.hits).toHaveLength(1);
    expect(all.total).toBe(page1.total);
  });

  it("treats FTS5 operators as plain text safely", () => {
    expect(() => search('NOT "a" OR NEAR')).not.toThrow();
  });

  it("returns zero hits for unknown terms", () => {
    const result = search("xyzzyplugh");
    expect(result.total).toBe(0);
    expect(result.hits).toHaveLength(0);
  });

  it("respects alias in title/body but tags filter uses indexed tags", () => {
    const sos = search("sos comercial");
    expect(sos.hits.some((h) => h.documentId === "concept.sales-operating-system")).toBe(true);
  });
});
