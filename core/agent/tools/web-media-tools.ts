/**
 * Web and media tools — wrap REAL backends:
 * - web_search    → DDG HTML (core/tools/web-tools.ts)
 * - web_fetch     → readable-text extractor (core/tools/web-tools.ts)
 * - image_generate → Pollinations FLUX free (core/tools/image-tools.ts)
 */

import type { ToolDefinition, ToolExecutionContext } from "./registry.ts";
import { webSearch, webFetch } from "../../tools/web-tools.ts";
import { generateImage } from "../../tools/image-tools.ts";

export const webSearchTool: ToolDefinition = {
  id: "web_search",
  name: "Pesquisar na internet",
  description:
    "Busca web via DuckDuckGo HTML (sem API key). Retorna título, URL e snippet dos resultados. Use para pesquisa pública de mercado, notícias, fornecedores, empresas sem site etc.",
  category: "research",
  permissions: ["READ", "NETWORK"],
  riskLevel: "LOW",
  requiresApproval: false,
  timeoutMs: 20_000,
  provenance: "external:duckduckgo",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "texto da busca" },
      maxResults: { type: "number", description: "máx. de resultados (default 8)" },
    },
    required: ["query"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input) => {
    const results = await webSearch(String(input.query ?? ""), Number(input.maxResults ?? 8));
    return { success: true, output: results };
  },
};

export const webFetchTool: ToolDefinition = {
  id: "web_fetch",
  name: "Ler página da internet",
  description:
    "Baixa uma URL e extrai o texto legível (remove scripts/styles/marcas). Use para ler conteúdo real de uma página encontrada na busca.",
  category: "research",
  permissions: ["READ", "NETWORK"],
  riskLevel: "LOW",
  requiresApproval: false,
  timeoutMs: 20_000,
  provenance: "external:http",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "URL (http/https)" },
    },
    required: ["url"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input) => {
    const page = await webFetch(String(input.url ?? ""));
    return { success: true, output: { title: page.title, url: page.url, text: page.text.slice(0, 8000) } };
  },
};

export const imageGenerateTool: ToolDefinition = {
  id: "image_generate",
  name: "Gerar imagem",
  description:
    "Gera imagem a partir de um prompt via Pollinations FLUX (gratuito, sem API key). Retorna a URL pública da imagem.",
  category: "media",
  permissions: ["READ", "NETWORK"],
  riskLevel: "LOW",
  requiresApproval: true,
  timeoutMs: 90_000,
  provenance: "external:pollinations",
  inputSchema: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "descrição da imagem (detalhada, em inglês funciona melhor)" },
      width: { type: "number" },
      height: { type: "number" },
    },
    required: ["prompt"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input) => {
    const result = await generateImage(String(input.prompt ?? ""), 1);
    if (result.status !== "GENERATED") {
      return { success: false, error: result.error ?? `status ${result.status}`, output: null };
    }
    return { success: true, output: { urls: result.urls, model: result.model } };
  },
};

/** Goal tools — wrap REAL core/goals engine. WRITE tools need approval. */
export const goalCreateTool: ToolDefinition = {
  id: "goal_create",
  name: "Criar objetivo",
  description:
    "Cria um GOAL real (BUSINESS, PROJECT, FINANCIAL, MARKETING, SALES, etc.) no banco do Second Brain. Ex.: faturar R$5.000/mês, lançar site, aumentar leads.",
  category: "planning",
  permissions: ["WRITE"],
  riskLevel: "MEDIUM",
  requiresApproval: true,
  timeoutMs: 10_000,
  provenance: "second-brain:goal-engine",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "nome do objetivo" },
      description: { type: "string" },
      type: { type: "string", description: "BUSINESS|PROJECT|FINANCIAL|MARKETING|SALES|PRODUCT|PERSONAL|OPERATIONAL" },
      deadline: { type: "string", description: "prazo ISO (ex.: 2026-12-31)" },
      projectId: { type: "string" },
    },
    required: ["name"],
  },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const { createGoal } = await import("../../goals/goal-engine.ts");
    const { openDatabase } = await import("../../../storage/connection.ts");
    const db = openDatabase(ctx.config.dbPath);
    try {
      const goal = createGoal(db, {
        name: String(input.name ?? ""),
        description: input.description ? String(input.description) : undefined,
        type: (input.type as "PROJECT") ?? "PROJECT",
        deadline: input.deadline ? String(input.deadline) : undefined,
        projectId: input.projectId ? String(input.projectId) : undefined,
        ownerAgent: "manager",
      });
      return { success: true, output: { id: goal.id, name: goal.name, type: goal.type, status: goal.status } };
    } finally {
      db.close();
    }
  },
};

export const goalListTool: ToolDefinition = {
  id: "goal_list",
  name: "Listar objetivos",
  description: "Lista objetivos ativos do Second Brain, priorizados, com progresso.",
  category: "planning",
  permissions: ["READ"],
  riskLevel: "LOW",
  requiresApproval: false,
  timeoutMs: 10_000,
  provenance: "second-brain:goal-engine",
  inputSchema: { type: "object", properties: {}, required: [] },
  outputSchema: { type: "object", required: [] },
  available: true,
  execute: async (input, ctx) => {
    const { listActiveGoalsByPriority } = await import("../../goals/goal-engine.ts");
    const { openDatabase } = await import("../../../storage/connection.ts");
    const db = openDatabase(ctx.config.dbPath);
    try {
      const goals = listActiveGoalsByPriority(db, Number(input.limit ?? 10));
      return {
        success: true,
        output: goals.map((g) => ({ id: g.id, name: g.name, type: g.type, status: g.status, priority: g.priority })),
      };
    } finally {
      db.close();
    }
  },
};