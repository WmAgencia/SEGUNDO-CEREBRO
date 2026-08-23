import { DatabaseSync } from "node:sqlite";

const goalSchema = {
  name: z.string().min(1),
  description: z.string().optional(),
  type: z
    .enum([
      "BUSINESS",
      "PROJECT",
      "FINANCIAL",
      "MARKETING",
      "SALES",
      "PRODUCT",
      "PERSONAL",
      "OPERATIONAL",
    ])
    .optional(),
  status: z
    .enum(["DRAFT", "ACTIVE", "PAUSED", "ACHIEVED", "FAILED", "CANCELLED", "ARCHIVED"])
    .optional(),
  priority: z.number().int().min(1).max(5).optional(),
  metricName: z.string().optional(),
  target: z.number().optional(),
  currentValue: z.number().optional(),
  deadline: z.string().optional(),
  projectId: z.string().optional(),
};

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { toBrainError, ValidationError } from "../../core/errors/errors.ts";
import {
  searchMemories,
  getMemory,
  relatedMemories,
} from "../../core/memory/memory-engine.ts";
import { resolveTools } from "../../core/tools/tool-registry.ts";
import { searchSkills } from "../../core/skills/skill-engine.ts";
import {
  agentContext,
  listAgents,
} from "../../core/agents/agent-runtime.ts";
import { getProjectIntelligence } from "../../core/projects/project-intelligence.ts";
import { unifiedQuery } from "../../core/unified.ts";
import { observe } from "../../core/learning/learning-loop.ts";
import {
  createGoal,
  getGoal,
  updateGoal,
  listGoals,
  goalPriority,
  listActiveGoalsByPriority,} from "../../core/goals/goal-engine.ts";
import {
  addObservation,
  listObservations,
  createOpportunity,
  listOpportunities,} from "../../core/goals/funnel.ts";
import {
  createInitiative,
  getInitiative,
  listInitiatives,
  updateInitiativeStatus,
  scoreInitiative,
  planInitiative,
  approveInitiative,
  rejectInitiativeApproval,
  formatProposal,} from "../../core/goals/initiatives.ts";
import { brainNextActions } from "../../core/goals/proactive.ts";
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

import { loadConfigForTools } from "./tools.ts";
import { seedBrainTools } from "../../core/tools/tool-registry.ts";

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
  "brain_search_memory",
  "brain_get_memory",
  "brain_related_memories",
  "brain_search_tools",
  "brain_search_skills",
  "brain_agent_context",
  "brain_project",
  "brain_observe",
  "brain_query",
  "brain_goals",
  "brain_goal",
  "brain_create_goal",
  "brain_observations",
  "brain_opportunities",
  "brain_initiatives",
  "brain_proposals",
  "brain_next_actions",
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

  server.registerTool(
    "brain_search_memory",
    {
      title: "Brain Search Memory",
      description: "Busca memorias (episodica, semantica, decision, etc) por texto, entidade, projeto, tipo, categoria e importancia minima.",
      inputSchema: {
        query: z.string().optional(),
        entityId: z.string().optional(),
        project: z.string().optional(),
        kind: z.enum(["episodic", "semantic", "procedural", "decision", "relational"]).optional(),
        category: z.string().optional(),
        minImportance: z.number().min(0).max(1).optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    wrapJson((a: { query?: string; limit?: number } & Record<string, unknown>) =>
      toolSearchMemories(a),
    ),
  );

  server.registerTool("brain_get_memory", {
      title: "Brain Get Memory",
      description: "Retorna uma memoria pelo id (incrementa contador de acesso).",
      inputSchema: { id: z.number().int() },
    },
    wrapJson((a: { id: number }) => toolGetMemory(a)),
  );

  server.registerTool(
    "brain_related_memories",
    {
      title: "Brain Related Memories",
      description: "Memorias ligadas a uma entidade ou projeto.",
      inputSchema: {
        entityId: z.string().min(1),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    wrapJson((a: { entityId: string; limit?: number }) =>
      toolRelatedMemories(a),
    ),
  );

  server.registerTool(
    "brain_search_tools",
    {
      title: "Brain Search Tools",
      description: "Descobre ferramentas registradas relevantes para uma tarefa, com score, permissoes e disponibilidade.",
      inputSchema: {
        task: z.string().min(1),
        requirePermission: z.enum(["READ", "WRITE", "EXECUTE", "DELETE", "NETWORK", "ADMIN"]).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      },
    },
    wrapJson((a: { task: string; requirePermission?: "READ" | "WRITE" | "EXECUTE" | "DELETE" | "NETWORK" | "ADMIN"; limit?: number }) =>
      toolSearchTools(a),
    ),
  );

  server.registerTool(
    "brain_search_skills",
    {
      title: "Brain Search Skills",
      description: "Recomenda skills para uma tarefa com budget primary/supporting (3/3 default), provenance e razao.",
      inputSchema: {
        task: z.string().min(1),
        primary: z.number().int().min(1).max(5).optional(),
        supporting: z.number().int().min(0).max(8).optional(),
      },
    },
    wrapJson((a: { task: string; primary?: number; supporting?: number }) =>
      toolSearchSkills(a),
    ),
  );

  server.registerTool(
    "brain_agent_context",
    {
      title: "Brain Agent Context",
      description: "Context Package autorizado para um agente registrado (checa permissao context e status active).",
      inputSchema: {
        agentId: z.string().min(1),
        task: z.string().min(1),
        project: z.string().optional(),
        entity: z.string().optional(),
        depth: z.number().int().min(1).max(5).optional(),
        maxChars: z.number().int().min(100).optional(),
      },
    },
    wrapJson((a: { agentId: string; task: string; project?: string; entity?: string; depth?: number; maxChars?: number }) =>
      toolAgentContext(a),
    ),
  );

  server.registerTool(
    "brain_project",
    {
      title: "Brain Project Intelligence",
      description: "Intelligence de projeto: relacionados por tipo, decisoes, procedimentos, memorias, skills, tools, timeline e relacoes entre projetos.",
      inputSchema: { id: z.string().min(1) },
    },
    wrapJson((a: { id: string }) => toolProject(a)),
  );

  server.registerTool(
    "brain_observe",
    {
      title: "Brain Observe",
      description: "Registra observacao do learning loop; repeticoes viram candidates de aprendizado (governanca via CLI brain learn).",
      inputSchema: {
        observationType: z.string().min(1),
        subject: z.string().min(1),
        patternKey: z.string().optional(),
        threshold: z.number().int().min(1).optional(),
        payload: z.record(z.string(), z.unknown()).optional(),
      },
    },
    wrapJson((a: { observationType: string; subject: string; patternKey?: string; threshold?: number; payload?: Record<string, unknown> }) =>
      toolObserve(a),
    ),
  );

  server.registerTool(
    "brain_query",
    {
      title: "Brain Query (Unified)",
      description:
        "Interface unificada da V2: dado 'tenho que executar X', retorna intencao, entidades, contexto completo, memorias, decisoes, procedures, skills recomendadas, ferramentas e agentes apropriados.",
      inputSchema: {
        query: z.string().min(1),
        agentId: z.string().optional(),
        depth: z.number().int().min(1).max(5).optional(),
        maxChars: z.number().int().min(100).optional(),
      },
    },
    wrapJson((a: { query: string; agentId?: string; depth?: number; maxChars?: number }) =>
      toolUnifiedQuery(a),
    ),
  );

  server.registerTool(
    "brain_goals",
    {
      title: "Brain Goals",
      description:
        "Lista objetivos (GOALS). prioritized=true ordena por score deterministico com motivos explicados.",
      inputSchema: {
        status: z.string().optional(),
        type: z.string().optional(),
        prioritized: z.boolean().optional(),
      },
    },
    wrapJson((a: { status?: string; type?: string; prioritized?: boolean }) => {
      if (a.prioritized) return listActiveGoalsByPriority(openDb(), 5);
      const db = openDb();
      try {
        return listGoals(db, { status: a.status, type: a.type });
      } finally {
        db.close();
      }
    }),
  );

  server.registerTool(
    "brain_goal",
    {
      title: "Brain Goal",
      description:
        "Objetivo por id com progresso percentual deterministico e prioridade explicada.",
      inputSchema: { id: z.string().min(1) },
    },
    wrapJson((a: { id: string }) => {
      const g = getGoal(openDb(), a.id);
      const p = goalPriority(g);
      return { ...g, priorityScore: p.score, priorityReasons: p.reasons };
    }),
  );

  server.registerTool(
    "brain_create_goal",
    {
      title: "Brain Create Goal",
      description:
        "Cria um GOAL — o que queremos alcancar. Nao e tarefa nem iniciativa.",
      inputSchema: goalSchema,
    },
    wrapJson((a: Record<string, unknown>) =>
      createGoal(openDb(), a as unknown as Parameters<typeof createGoal>[1]),
    ),
  );

  server.registerTool(
    "brain_observations",
    {
      title: "Brain Observations",
      description:
        "Registra ou lista observacoes (METRIC_CHANGE, PROBLEM, OPPORTUNITY_SIGNAL, etc). Nao viram acoes automaticamente.",
      inputSchema: {
        action: z.enum(["add", "list"]).default("list"),
        type: z
          .enum([
            "METRIC_CHANGE",
            "NEW_INFORMATION",
            "PROBLEM",
            "OPPORTUNITY_SIGNAL",
            "DEADLINE",
            "PATTERN",
            "ANOMALY",
            "USER_SIGNAL",
          ])
          .optional(),
        source: z.string().optional(),
        projectId: z.string().optional(),
        entityId: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
        confidence: z.number().min(0).max(1).optional(),
        importance: z.number().min(0).max(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    wrapJson((a) => {
      const db = openDb();
      try {
        if (a.action === "add") {
          return addObservation(db, {
            type: (a.type ?? "USER_SIGNAL") as Parameters<
              typeof addObservation
            >[1]["type"],
            source: a.source,
            projectId: a.projectId,
            entityId: a.entityId,
            data: a.data,
            confidence: a.confidence,
            importance: a.importance,
          });
        }
        return listObservations(db, {
          type: a.type as never,
          projectId: a.projectId,
          limit: a.limit,
        });
      } finally {
        db.close();
      }
    }),
  );

  server.registerTool(
    "brain_opportunities",
    {
      title: "Brain Opportunities",
      description: "Cria ou lista oportunidades derivadas de observacoes.",
      inputSchema: {
        action: z.enum(["add", "list"]).default("list"),
        title: z.string().optional(),
        description: z.string().optional(),
        sourceObservationId: z.number().int().optional(),
        goalId: z.string().optional(),
        projectId: z.string().optional(),
        potentialImpact: z.number().optional(),
        estimatedEffort: z.number().optional(),
        risk: z.number().optional(),
        confidence: z.number().min(0).max(1).optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    wrapJson((a) => {
      const db = openDb();
      try {
        if (a.action === "add") {
          if (!a.title) throw new ValidationError("title required for add");
          return createOpportunity(db, {
            title: a.title,
            description: a.description,
            sourceObservationId: a.sourceObservationId,
            goalId: a.goalId,
            project: a.projectId,
            potentialImpact: a.potentialImpact,
            estimatedEffort: a.estimatedEffort,
            risk: a.risk,
            confidence: a.confidence,
          });
        }
        return listOpportunities(db, {
          projectId: a.projectId,
          limit: a.limit,
        });
      } finally {
        db.close();
      }
    }),
  );

  server.registerTool(
    "brain_initiatives",
    {
      title: "Brain Initiatives",
      description:
        "Gerencia iniciativas: create | list | score | plan | approve | reject. Aprovacao humana explicita; nada executa automaticamente nesta fase.",
      inputSchema: {
        action: z.enum(["create", "list", "score", "plan", "approve", "reject"]),
        id: z.string().optional(),
        title: z.string().optional(),
        description: z.string().optional(),
        goalId: z.string().optional(),
        projectId: z.string().optional(),
        hypothesisId: z.number().int().optional(),
        impact: z.number().min(0).max(10).optional(),
        probability: z.number().min(0).max(10).optional(),
        effort: z.number().min(0).max(10).optional(),
        risk: z.number().min(0).max(10).optional(),
        expectedOutcome: z.string().optional(),
        approvedBy: z.string().optional(),
        rejectionReason: z.string().optional(),
        tasks: z.array(z.string()).optional(),
      },
    },
    wrapJson((a) => {
      const db = openDb();
      try {
        switch (a.action) {
          case "create": {
            const init = createInitiative(db, {
              title: a.title ?? "",
              description: a.description,
              goalId: a.goalId,
              project: a.projectId,
              hypothesisId: a.hypothesisId,
              impact: a.impact,
              probability: a.probability,
              effort: a.effort,
              risk: a.risk,
              expectedOutcome: a.expectedOutcome,
            });
            updateInitiativeStatus(db, init.id, "AWAITING_APPROVAL");
            return getInitiative(db, init.id);
          }
          case "list":
            return listInitiatives(db);
          case "score": {
            if (!a.id) throw new ValidationError("id required for score");
            const init = getInitiative(db, a.id);
            return scoreInitiative(init);
          }
          case "plan": {
            if (!a.id) throw new ValidationError("id required for plan");
            return planInitiative(db, a.id, a.tasks);
          }
          case "approve": {
            if (!a.id) throw new ValidationError("id required for approve");
            updateInitiativeStatus(db, a.id, "APPROVED");
            return approveInitiative(db, a.id, a.approvedBy ?? "human");
          }
          case "reject": {
            if (!a.id) throw new ValidationError("id required for reject");
            updateInitiativeStatus(db, a.id, "REJECTED");
            rejectInitiativeApproval(db, a.id, a.rejectionReason ?? null, a.approvedBy ?? "human");
            return getInitiative(db, a.id);
          }
          default:
            throw new ValidationError("unknown action");
        }
      } finally {
        db.close();
      }
    }),
  );

  server.registerTool(
    "brain_proposals",
    {
      title: "Brain Proposals",
      description:
        "Proposta formatada para aprovacao humana: objetivo, hipotese, plano, agentes, skills, tools, custo, risco, score e motivo.",
      inputSchema: { initiativeId: z.string().min(1) },
    },
    wrapJson((a: { initiativeId: string }) => ({
      proposal: formatProposal(openDb(), loadConfigForTools(), a.initiativeId),
    })),
  );

  server.registerTool(
    "brain_next_actions",
    {
      title: "Brain Next Actions",
      description:
        "Responde 'o que deveriamos fazer agora?': objetivos ativos priorizados, observacoes recentes, iniciativas aguardando aprovacao e recomendacoes com motivos. OBSERVA/ANALISA/PROPOE — nao executa.",
      inputSchema: {},
    },
    wrapJson(() => brainNextActions(loadConfigForTools())),
  );

  return server;
}

function openDb() {
  return new DatabaseSync(loadConfigForTools().dbPath);
}

function toolSearchMemories(a: { query?: string; entityId?: unknown; project?: unknown; kind?: unknown; category?: unknown; minImportance?: unknown; from?: unknown; to?: unknown; limit?: number }) {
  const db = new DatabaseSync(loadConfigForTools().dbPath);
  try {
    return searchMemories(db, {
      text: typeof a.query === "string" ? a.query : undefined,
      entityId: typeof a.entityId === "string" ? a.entityId : undefined,
      project: typeof a.project === "string" ? a.project : undefined,
      kind: typeof a.kind === "string" ? a.kind : undefined,
      category: typeof a.category === "string" ? a.category : undefined,
      minImportance: typeof a.minImportance === "number" ? a.minImportance : undefined,
      from: typeof a.from === "string" ? a.from : undefined,
      to: typeof a.to === "string" ? a.to : undefined,
      limit: a.limit,
    });
  } finally {
    db.close();
  }
}

function toolGetMemory(a: { id: number }) {
  const db = new DatabaseSync(loadConfigForTools().dbPath);
  try {
    return getMemory(db, a.id);
  } finally {
    db.close();
  }
}

function toolRelatedMemories(a: { entityId: string; limit?: number }) {
  const db = new DatabaseSync(loadConfigForTools().dbPath);
  try {
    return relatedMemories(db, a.entityId, a.limit ?? 10);
  } finally {
    db.close();
  }
}

function toolSearchTools(a: { task: string; requirePermission?: "READ" | "WRITE" | "EXECUTE" | "DELETE" | "NETWORK" | "ADMIN"; limit?: number }) {
  const db = new DatabaseSync(loadConfigForTools().dbPath);
  try {
    seedIfEmpty(db);
    return resolveTools(db, a.task, {
      requirePermission: a.requirePermission,
      limit: a.limit ?? 5,
    });
  } finally {
    db.close();
  }
}

function toolSearchSkills(a: { task: string; primary?: number; supporting?: number }) {
  const db = new DatabaseSync(loadConfigForTools().dbPath);
  try {
    return searchSkills(db, a.task, { primary: a.primary, supporting: a.supporting });
  } finally {
    db.close();
  }
}

function toolAgentContext(a: { agentId: string; task: string; project?: string; entity?: string; depth?: number; maxChars?: number }) {
  return agentContext(loadConfigForTools(), a);
}

function toolProject(a: { id: string }) {
  return getProjectIntelligence(loadConfigForTools(), a.id);
}

function toolObserve(a: { observationType: string; subject: string; patternKey?: string; threshold?: number; payload?: Record<string, unknown> }) {
  const db = new DatabaseSync(loadConfigForTools().dbPath);
  try {
    return observe(db, a);
  } finally {
    db.close();
  }
}

function toolUnifiedQuery(a: { query: string; agentId?: string; depth?: number; maxChars?: number }) {
  return unifiedQuery(loadConfigForTools(), a);
}

function seedIfEmpty(db: DatabaseSync): void {
  const row = db.prepare("SELECT COUNT(*) AS c FROM tools_registry").get() as {
    c: number;
  };
  if ((row?.c ?? 0) === 0) {
    seedBrainTools(db);
  }
}
