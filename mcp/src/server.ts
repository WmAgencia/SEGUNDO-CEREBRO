import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toBrainError } from "../../core/errors/errors.ts";
import {
  toolBrainContext,
  toolBrainGet,
  toolBrainHealth,
  toolBrainLink,
  toolBrainRelated,
  toolBrainRemember,
  toolBrainResolve,
  toolBrainSearch,
  toolBrainSources,
  toolBrainTimeline,
} from "./tools.ts";

const MEMORY_KINDS = ["episodic", "semantic", "procedural", "decision", "relational"] as const;

export const TOOL_NAMES = [
  "brain_search",
  "brain_resolve",
  "brain_get",
  "brain_related",
  "brain_context",
  "brain_timeline",
  "brain_sources",
  "brain_remember",
  "brain_link",
  "brain_health",
] as const;

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const brainErr = toBrainError(err);
  return {
    isError: true,
    content: [{ type: "text" as const, text: JSON.stringify(brainErr.toJSON(), null, 2) }],
  };
}

type ToolHandler<T> = (args: T) => unknown;

function wrapJson<T>(handler: ToolHandler<T>) {
  return async (args: T) => {
    try {
      return jsonResult(await Promise.resolve(handler(args)));
    } catch (err) {
      return errorResult(err);
    }
  };
}

export function createBrainMcpServer(): McpServer {
  const server = new McpServer(
    { name: "second-brain-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.registerTool(
    "brain_search",
    {
      title: "Brain Search",
      description:
        "Busca lexical no Second Brain (FTS5). Retorna documentos com score, snippet, tipo, path, entidades e fonte.",
      inputSchema: {
        query: z.string().describe("texto de busca; operadores especiais sao tratados como texto"),
        limit: z.number().int().min(1).max(50).optional(),
        offset: z.number().int().min(0).optional(),
        type: z.array(z.string()).optional().describe("filtra por tipos de documento/entidade"),
        tag: z.string().optional(),
        pathPrefix: z.string().optional(),
      },
    },
    wrapJson(toolBrainSearch),
  );

  server.registerTool(
    "brain_resolve",
    {
      title: "Brain Resolve",
      description:
        'Resolve um texto para a entidade mais provavel. Estrategias: id > alias > nome > prefixo unico > busca. Retorna best e candidates.',
      inputSchema: { query: z.string().min(1) },
    },
    wrapJson(toolBrainResolve),
  );

  server.registerTool(
    "brain_get",
    {
      title: "Brain Get",
      description: "Retorna uma entidade especifica (aceita id, alias ou nome) com estatisticas.",
      inputSchema: { id: z.string().min(1) },
    },
    wrapJson(toolBrainGet),
  );

  server.registerTool(
    "brain_related",
    {
      title: "Brain Related",
      description:
        "Entidades relacionadas no grafo de conhecimento. Suporta direcao, profundidade (1-5), filtro por tipo de relacao e data de referencia temporal.",
      inputSchema: {
        id: z.string().min(1),
        depth: z.number().int().min(1).max(5).optional(),
        direction: z.enum(["out", "in", "both"]).optional(),
        relationTypes: z.array(z.string()).optional(),
        asOf: z.string().optional().describe("data ISO de referencia para validez temporal"),
      },
    },
    wrapJson(toolBrainRelated),
  );

  server.registerTool(
    "brain_context",
    {
      title: "Brain Context",
      description:
        "Monta contexto consolidado para trabalhar em um assunto: resumo, status, relacionados, decisoes, procedimentos, eventos, documentos, fontes e avisos. Or??amento de caracteres garantido.",
      inputSchema: {
        subject: z.string().min(1),
        task: z.string().optional().describe("tarefa pretendida; afina documentos"),
        depth: z.number().int().min(1).max(5).optional(),
        maxChars: z.number().int().min(100).optional(),
      },
    },
    wrapJson(toolBrainContext),
  );

  server.registerTool(
    "brain_timeline",
    {
      title: "Brain Timeline",
      description: "Evolucao historica de uma entidade: eventos, relacoes, documento e memorias.",
      inputSchema: {
        entityId: z.string().min(1),
        limit: z.number().int().min(1).max(200).optional(),
        kinds: z
          .array(z.enum(["event", "relation", "document", "memory"]))
          .optional(),
      },
    },
    wrapJson(toolBrainTimeline),
  );

  server.registerTool(
    "brain_sources",
    {
      title: "Brain Sources",
      description:
        "Provenance: fontes de uma entidade (documento de origem + fontes das relacoes) ou lista geral de fontes.",
      inputSchema: { entityId: z.string().optional() },
    },
    wrapJson(toolBrainSources),
  );

  server.registerTool(
    "brain_remember",
    {
      title: "Brain Remember",
      description:
        "Registra uma memoria na base (NUNCA modifica o vault Obsidian). Fonte registrada: conversation.",
      inputSchema: {
        content: z.string().min(1),
        memory_kind: z.enum(MEMORY_KINDS),
        category: z.string().optional().describe("ex.: FACT, DECISION, IDEA, PREFERENCE"),
        entityId: z.string().optional().describe("entidade relacionada (id, alias ou nome)"),
        confidence: z.number().min(0).max(1).optional(),
      },
    },
    wrapJson(toolBrainRemember),
  );

  server.registerTool(
    "brain_link",
    {
      title: "Brain Link",
      description:
        "Cria uma relacao entre duas entidades existentes. Fonte registrada: conversation. Nao altera o vault.",
      inputSchema: {
        sourceEntity: z.string().min(1),
        targetEntity: z.string().min(1),
        relationType: z.string().min(1).describe("ex.: USES, RELATED_TO, PART_OF"),
        confidence: z.number().min(0).max(1).optional(),
        validFrom: z.string().optional(),
      },
    },
    wrapJson(toolBrainLink),
  );

  server.registerTool(
    "brain_health",
    {
      title: "Brain Health",
      description:
        "Saude do cerebro: contagens de documentos/entidades/relacoes/memorias/eventos, ultima indexacao, versao de schema e caminhos.",
      inputSchema: {},
    },
    wrapJson(toolBrainHealth),
  );

  return server;
}
