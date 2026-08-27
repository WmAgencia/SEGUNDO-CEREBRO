/**
 * Planner — deterministic intent classification and Graph plan generation.
 *
 * The Single Agent remains the DECISION MAKER (it owns the conversation and
 * chooses graph_plan/graph_execute). This module is the deterministic engine
 * behind graph_plan: it decides whether a request really needs a DAG
 * (multi-step work) and builds the plan. Simple requests → returns null
 * (the agent handles them as conversation or a single tool).
 *
 * Rule-based by design (no LLM invention of DAG structure): stable, cheap,
 * testable. The LLM can still override by asking the user before executing.
 */

import type { GraphPlan } from "./types.ts";

export type RequestIntent =
  | "SIMPLE"
  | "TOOL"
  | "PLAN"
  | "GRAPH";

const GREETINGS = /^(oi|ola|olá|eai|e aí|hey|hello|bom dia|boa tarde|boa noite|ei|tudo bem|vc ta aí|você está aí|valeu|obrigado|obrigada)[!?.]*$/i;

const SIMPLE_QUERY = /^(o que|qual|quais|como( esta| está| foi)?|me mostre|mostre me|resumo|what is|what are|status de|estado do|consulta|explica|explique|summary of)\b/i;

// single-tool intents — the agent handles with exactly one tool, no DAG
const TOOL_INTENTS: Array<{ re: RegExp; tool: string }> = [
  { re: /(procur|busca|pesquis|search|find)/i, tool: "brain_search" },
  { re: /(status do whats|whatsapp status|instancia.*(conect|ativa|status)|wa status)/i, tool: "whatsapp_status" },
  { re: /(enviar whats|manda.*whats|whats.*para)/i, tool: "whatsapp_send" },
  { re: /(agenda|compromisso|reuni[ãa]o).*(hoje|amanh[ãa]|ver|mostra|list)/i, tool: "agenda_list" },
  { re: /(memorias|memórias|lembra)/i, tool: "memory_search" },
  { re: /(objetivos|goals|metas) ativos/i, tool: "goal_list" },
];

// multi-step work patterns → GRAPH
function graphKind(request: string): "rebuild" | "system_build" | "prospection" | "video" | null {
  const t = request;
  if (/(prospec[çc][ãa]o|prospec|capta[çc][ãa]o de clientes|funil de vendas)/i.test(t)) return "prospection";
  if (/(gerar video|gera[çc][ãa]o de video|video automatizado|sistema de videos?)/i.test(t)) return "video";
  if (/(funciona(ndo|l))|deixar .*100|colocar .* pra funcionar|implantar|implementar|reparar|arrumar|corrigir|reconstruir|refatorar|auditar|revis[ãa]o geral|colocar .* no ar|colocar .* funcionando/i.test(t)) {
    return "rebuild";
  }
  if (/(sistema de|criar (um )?(sistema|projeto|app)|desenvolver (um )?(sistema|projeto|app)|fazer (um )?(site|app|sistema)|construir)/i.test(t)) return "system_build";
  return null;
}

export function classifyIntent(request: string): RequestIntent {
  const trimmed = request.trim();
  if (!trimmed) return "SIMPLE";
  if (GREETINGS.test(trimmed)) return "SIMPLE";
  if (SIMPLE_QUERY.test(trimmed)) return "TOOL";
  if (TOOL_INTENTS.some(({ re }) => re.test(trimmed))) return "TOOL";
  if (graphKind(trimmed)) return "GRAPH";
  return "PLAN";
}

function baseNodes(kind: NonNullable<ReturnType<typeof graphKind>>): GraphPlan["nodes"] {
  switch (kind) {
    case "prospection":
      return [
        { id: "research", title: "Research", type: "research", description: "Investigar o mercado, canais e dados existentes de prospecção." },
        { id: "architecture", title: "Architecture", type: "architecture", dependencies: ["research"], description: "Definir arquitetura do sistema de prospecção." },
        { id: "design", title: "Design", type: "design", dependencies: ["research"], description: "Projetar UX/fluxos do funil de prospecção." },
        { id: "implementation", title: "Implementation", type: "implementation", dependencies: ["architecture", "design"], description: "Implementar o sistema." },
        { id: "integration", title: "Integration", type: "integration", dependencies: ["implementation"], description: "Integrar canais e APIs (WhatsApp, leads)." },
        { id: "qa", title: "QA", type: "qa", dependencies: ["integration"], description: "Validar com testes reais." },
        { id: "deploy", title: "Deploy", type: "deploy", dependencies: ["qa"], description: "Publicar e verificar em produção." },
      ];
    case "video":
      return [
        { id: "research", title: "Research", type: "research", description: "Levantar providers e custos de geração de vídeo." },
        { id: "architecture", title: "Architecture", type: "architecture", dependencies: ["research"], description: "Arquitetura de geração de vídeo." },
        { id: "implementation", title: "Implementation", type: "implementation", dependencies: ["architecture"], description: "Implementar geração de vídeo." },
        { id: "integration", title: "Integration", type: "integration", dependencies: ["implementation"], description: "Integrar com o restante do sistema." },
        { id: "qa", title: "QA", type: "qa", dependencies: ["integration"], description: "Testar geração e posting automático." },
        { id: "deploy", title: "Deploy", type: "deploy", dependencies: ["qa"], description: "Deploy e monitoramento." },
      ];
    case "system_build":
      return [
        { id: "research", title: "Research", type: "research", description: "Levantar requisitos e estado atual do sistema." },
        { id: "architecture", title: "Architecture", type: "architecture", dependencies: ["research"], description: "Definir arquitetura." },
        { id: "design", title: "Design", type: "design", dependencies: ["research"], description: "Desenhar UI/fluxos." },
        { id: "implementation", title: "Implementation", type: "implementation", dependencies: ["architecture", "design"], description: "Implementar." },
        { id: "integration", title: "Integration", type: "integration", dependencies: ["implementation"], description: "Integrar serviços." },
        { id: "qa", title: "QA", type: "qa", dependencies: ["integration"], description: "Testes de integração." },
        { id: "deploy", title: "Deploy", type: "deploy", dependencies: ["qa"], description: "Deploy." },
      ];
    default:
      return [
        { id: "audit", title: "Audit", type: "audit", description: "Auditar estado atual do sistema/projeto." },
        { id: "identify", title: "Identify problems", type: "research", dependencies: ["audit"], description: "Identificar problemas e lacunas." },
        { id: "architecture", title: "Architecture", type: "architecture", dependencies: ["identify"], description: "Propor arquitetura/solução." },
        { id: "implementation", title: "Implementation", type: "implementation", dependencies: ["architecture"], description: "Implementar as correções/features." },
        { id: "qa", title: "QA", type: "qa", dependencies: ["implementation"], description: "Validar com testes e evidência." },
        { id: "verify", title: "Verify", type: "verify", dependencies: ["qa"], description: "Verificar resultado final ponta a ponta." },
      ];
  }
}

/**
 * Generates a GraphPlan for requests that legitimately need multi-step work,
 * otherwise returns null (agent keeps simple/tool path).
 */
export function planForRequest(request: string, opts: { projectId?: string | null } = {}): GraphPlan | null {
  const kind = graphKind(request);
  if (!kind) return null;
  return {
    goal: summarizeGoal(request),
    projectId: opts.projectId ?? null,
    nodes: baseNodes(kind).map((n) => {
      const input = { request: request.slice(0, 2000), task: n.description };
      if (opts.projectId) (input as Record<string, unknown>).projectId = opts.projectId;
      return { ...n, input };
    }),
  };
}

function summarizeGoal(request: string): string {
  return request.trim().slice(0, 240);
}