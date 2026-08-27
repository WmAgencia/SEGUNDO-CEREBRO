/**
 * Brain, Memory and Obsidian tools — all wrap REAL backends:
 * - brain_search   → core/retrieval/searcher.ts (FTS5 BM25 over the vault index)
 * - memory_search  → core/memory/memory-engine.ts (searchMemories)
 * - memory_write   → core/memory/memory-engine.ts (createMemory) [WRITE, needs approval]
 * - obsidian_sync  → core/indexing/vault-indexer.ts (indexVault) [WRITE, needs approval]
 */

import { ToolDefinition, ToolExecutionContext } from "./registry.js";
import { searchDocuments } from "../../retrieval/searcher.ts";
import { searchMemories, createMemory } from "../../memory/memory-engine.ts";
import { indexVault } from "../../indexing/vault-indexer.ts";
import type { BrainConfig } from "../../config/loader.ts";

function configOf(ctx: ToolExecutionContext): BrainConfig {
  return ctx.config;
}

export const brainSearchTool: ToolDefinition = {
  id: "brain_search",
  name: "Pesquisar no Second Brain",
  description:
    "Busca léxica no índice do Obsidian (FTS5 + BM25). Retorna documentos com score, snippet, tipo e caminho. Use para encontrar notas, decisões, procedimentos e conhecimento do vault.",
  category: "knowledge",
  permissions: ["READ"],
  riskLevel: "LOW",
  requiresApproval: false,
  timeoutMs: 10_000,
  provenance: "second-brain:searcher",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "texto de busca" },
      limit: { type: "number", description: "máx. de resultados (default 8)" },
      type: { type: "array", description: "filtra por tipos (ex.: document, note, decision)" },
    },
    required: ["query"],
  },
  outputSchema: {
    type: "object",
    properties: {
      hits: { type: "array", description: "documentos encontrados" },
      total: { type: "number" },
    },
    required: ["hits", "total"],
  },
  available: true,
  execute: async (input, ctx) => {
    const cfg = configOf(ctx);
    const result = searchDocuments({
      dbPath: cfg.dbPath,
      query: String(input.query ?? ""),
      limit: Number(input.limit ?? 8),
      filters: input.type ? { type: input.type as string[] } : undefined,
    });
    return {
      success: true,
      output: {
        hits: result.hits.map((h) => ({
          id: h.documentId,
          title: h.title,
          path: h.path,
          type: h.type,
          score: h.score,
          snippet: h.snippet,
          sourceType: h.sourceType,
        })),
        total: result.total,
        strategy: result.strategy,
      },
    };
  },
};

export const memorySearchTool: ToolDefinition = {
  id: "memory_search",
  name: "Buscar memórias",
  description:
    "Busca memórias persistentes (episódicas, semânticas, decisões, procedimentos) por texto, entidade ou projeto.",
  category: "knowledge",
  permissions: ["READ"],
  riskLevel: "LOW",
  requiresApproval: false,
  timeoutMs: 10_000,
  provenance: "second-brain:memory-engine",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "texto de busca" },
      entityId: { type: "string", description: "entidade relacionada (ex.: project.vyntra)" },
      project: { type: "string", description: "projeto" },
      limit: { type: "number", description: "máx. de resultados (default 8)" },
    },
    required: ["query"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const { openDatabase } = await import("../../../storage/connection.ts");
    const cfg = configOf(ctx);
    const db = openDatabase(cfg.dbPath);
    try {
      const rows = searchMemories(db, {
        text: String(input.query ?? ""),
        entityId: input.entityId ? String(input.entityId) : undefined,
        project: input.project ? String(input.project) : undefined,
        limit: Number(input.limit ?? 8),
      });
      return {
        success: true,
        output: rows.map((r) => ({
          id: r.id,
          content: r.content,
          kind: r.memoryKind,
          category: r.category,
          entityId: r.entityId,
          project: r.project,
          importance: r.importance,
          createdAt: r.createdAt,
        })),
      };
    } finally {
      db.close();
    }
  },
};

export const memoryWriteTool: ToolDefinition = {
  id: "memory_write",
  name: "Registrar memória",
  description:
    "Grava uma memória persistente (fato, decisão, preferência, aprendizado, ideia). Tudo relevante das conversas deve virar memória.",
  category: "knowledge",
  permissions: ["WRITE"],
  riskLevel: "LOW",
  requiresApproval: true,
  timeoutMs: 10_000,
  provenance: "second-brain:memory-engine",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string", description: "conteúdo da memória" },
      kind: { type: "string", description: "episodic | semantic | procedural | decision | relational" },
      category: { type: "string", description: "FACT | DECISION | IDEA | PREFERENCE | LESSON" },
      entityId: { type: "string", description: "entidade relacionada" },
      confidence: { type: "number" },
    },
    required: ["content"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const { openDatabase } = await import("../../../storage/connection.ts");
    const cfg = configOf(ctx);
    const db = openDatabase(cfg.dbPath);
    try {
      const memory = createMemory(db, {
        content: String(input.content ?? ""),
        memoryKind: String(input.kind ?? "semantic"),
        category: input.category ? String(input.category) : undefined,
        entityId: input.entityId ? String(input.entityId) : undefined,
        confidence: input.confidence ? Number(input.confidence) : undefined,
      });
      return { success: true, output: { id: memory.id, content: memory.content, kind: memory.memoryKind } };
    } finally {
      db.close();
    }
  },
};

export const obsidianSyncTool: ToolDefinition = {
  id: "obsidian_sync",
  name: "Reindexar Obsidian",
  description:
    "Reescaneia o vault Obsidian e atualiza o índice (documents, entities, relations). Use após alterações manuais do vault.",
  category: "knowledge",
  permissions: ["WRITE"],
  riskLevel: "LOW",
  requiresApproval: true,
  timeoutMs: 120_000,
  provenance: "second-brain:vault-indexer",
  inputSchema: { type: "object", properties: {}, required: [] },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (_input, ctx) => {
    const cfg = configOf(ctx);
    const report = indexVault(cfg);
    return {
      success: true,
      output: {
        scanned: report.scanned,
        added: report.added,
        changed: report.changed,
        removed: report.removed,
        renamed: report.renamed,
        errors: report.errors,
      },
    };
  },
};