/**
 * Single Agent orchestrator — the conversational core of the new Second Brain.
 *
 * Flow per user turn:
 *   persist user message
 *   → compile context (context-compiler + session + memory + agenda + goals)
 *   → LLM (real, via completeWithGateway / Groq pool + OpenRouter fallback)
 *   → if LLM requests a tool (JSON `{"tool":...,"input":{...}}`) → ToolExecutor
 *     (approval gate via requestApproval) → feed result back → LLM final answer
 *   → persist assistant message
 *   → persist relevant memory (decision/idea/preference) with provenance
 *
 * No deterministic fake answers except when the LLM is genuinely unavailable
 * (no keys configured), in which case it says so clearly instead of faking.
 */

import { ToolRegistry, ToolExecutor, createDefaultRegistry } from "./tools/index.ts";
import type { BrainConfig } from "../config/loader.ts";

export interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

/** Real lifecycle events emitted while a turn runs (FASE 3.7 streaming). */
export interface AgentEvent {
  type: "context_compiled" | "thinking" | "tool_start" | "tool_result" | "approval_requested" | "answer";
  toolId?: string;
  success?: boolean;
  graph?: boolean;
  detail?: string;
  output?: unknown;
}

export type AgentEventListener = (evt: AgentEvent) => void;

export interface ChatTurnResult {
  message?: ChatMessage;
  type: "answer" | "approval_requested" | "error";
  approval?: { toolId: string; input: Record<string, unknown> };
  contextUsed?: { used: number; max: number };
  toolResults?: Array<{ toolId: string; success: boolean; error?: string; output?: unknown }>;
}

export interface SingleAgentOptions {
  llm?: (messages: ChatMessage[]) => Promise<{ content: string }>;
  registry?: ToolRegistry;
  maxTurns?: number;
  /** Deadline total do loop (ms). Evita loop infinito por tempo. */
  loopTimeoutMs?: number;
  /** Máx. de chamadas de ferramenta idênticas (mesma tool+input) sem progresso. */
  maxRepeatedToolCalls?: number;
  /** Máx. de falhas consecutivas da mesma ferramenta antes de parar. */
  maxPersistentFailures?: number;
}

const DEFAULT_SYSTEM: ChatMessage = {
  role: "system",
  content: [
    "Você é o Second Brain, um assistente pessoal de IA conversacional.",
    "Converse naturalmente, em português, como um parceiro humano.",
    "Você tem acesso a um Second Brain: memórias, notas do Obsidian, objetivos, agenda e ferramentas.",
    "",
    "REGRAS:",
    "- Não repita frases prontas como 'quer que eu analise', 'quer transformar em acionável'.",
    "- Se o usuário traz uma ideia ou decisão, registre-a com a ferramenta memory_write (inventar nada).",
    "- Esse objetivo é essencialmente conversacional: raciocine junto e pergunte o necessário.",
    "- PARA USAR UMA FERRAMENTA, responda SOMENTE com JSON válido neste formato (sem markdown):",
    '{"tool":"<id>","input":{...}}',
    "- Ferramentas disponíveis listadas no contexto (seção FERRAMENTAS).",
    "- Se o contexto não mostrar uma ferramenta, não a use.",
    "- NUNCA invente dados; diga quando não souber.",
    "- Para cancelar/abortar a execução de um trabalho, avise e pare.",
    "",
    "TRABALHO MULTI-ETAPAS:",
    "- Para pedidos complexos (ex.: 'colocar o ClipCom funcionando', 'criar sistema de prospecção'), planeje com graph_plan e, após o usuário autorizar, execute com graph_execute.",
    "- Use graph_status para acompanhar e graph_list para ver runs da sessão.",
    "- graph_execute requer aprovação do usuário (nunca abra um graph sem autorização).",
    "- Para consultas simples use apenas as ferramentas diretas (brain_search, etc.) — não crie graph desnecessariamente.",
  ].join("\n"),
};

function parseToolRequest(content: string): { tool: string; input: Record<string, unknown> } | null {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(trimmed) as { tool?: string; input?: Record<string, unknown> };
    if (!parsed.tool) return null;
    return { tool: parsed.tool, input: typeof parsed.input === "object" && parsed.input ? parsed.input : {} };
  } catch {
    return null;
  }
}

export class SingleAgent {
  private executor: ToolExecutor;
  private registry: ToolRegistry;
  private llm: (messages: ChatMessage[]) => Promise<{ content: string }>;
  private maxTurns: number;
  private loopTimeoutMs: number;
  private maxRepeatedToolCalls: number;
  private maxPersistentFailures: number;

  constructor(options: SingleAgentOptions = {}) {
    this.registry = options.registry ?? createDefaultRegistry();
    this.executor = new ToolExecutor(this.registry);
    this.llm = options.llm ?? (async (messages) => {
      const { completeWithGateway } = await import("../ai/model-router.ts");
      const gatewayMessages = messages.map((m) => ({ role: m.role as "user" | "assistant" | "system", content: m.content }));
      const result = await completeWithGateway(
        await openLedger(),
        { messages: gatewayMessages, maxTokens: 900, temperature: 0.4 },
        { workload: "reasoning", agent: "single-agent", task: messages.at(-1)?.content ?? "" },
      );
      return { content: result.content };
    });
    this.maxTurns = options.maxTurns ?? 8;
    this.loopTimeoutMs = options.loopTimeoutMs ?? 180_000;
    this.maxRepeatedToolCalls = options.maxRepeatedToolCalls ?? 3;
    this.maxPersistentFailures = options.maxPersistentFailures ?? 3;
  }

  /** Full turn: persist → context → LLM → (tool) → final answer → persist memory. */
  async chat(
    config: BrainConfig,
    sessionKey: string,
    userText: string,
    requestApproval?: (toolId: string, input: Record<string, unknown>) => Promise<boolean>,
    opts: {
      llm?: (m: ChatMessage[]) => Promise<{ content: string }>;
      resumeApproval?: { toolId: string; input: Record<string, unknown> } | null;
      /** Retorna approval_requested sem aguardar o callback HTTP do frontend. */
      deferApproval?: boolean;
      onEvent?: AgentEventListener;
      /** Kill switch: se abortado, o loop para imediatamente. */
      signal?: AbortSignal;
    } = {},
  ): Promise<ChatTurnResult> {
    const emit = opts.onEvent ?? (() => {});
    const persistUser = (await import("./session-store.ts")).persistMessage;
    const appendUser = userText.trim();
    if (!appendUser && !opts.resumeApproval) return { type: "error" };
    if (appendUser) persistUser(config, sessionKey, "user", appendUser);

    const history = (await import("./session-store.ts")).getMessages(config, sessionKey, 12);
    const toolList = this.registry.available().map((t) => `${t.id}: ${t.description}`).join("\n");

    let turnCount = 0;
    let contextNote = "";
    let toolResults: ChatTurnResult["toolResults"] = [];
    // Salvaguardas do loop autônomo (FASE consolidação, seção 2):
    const loopStartedAt = Date.now();
    const toolCallSignatures = new Map<string, number>(); // tool+input -> qtd de chamadas
    const toolFailureStreak = new Map<string, number>(); // tool -> falhas consecutivas

    // 1. compile context (deterministic)
    const cctx = await (await import("./context-compiler.ts")).compileContext({ subject: appendUser || "continuar trabalho" }, config);
    emit({ type: "context_compiled", detail: `contexto compilado (${cctx.charBudget.used}/${cctx.charBudget.max} chars)` });
    // Dica de intenção (heurística) — auxilia o agente, não o obriga. O LLM decide.
    let intentHint = "";
    if (appendUser) {
      try {
        const { classifyIntent } = await import("../orchestration/planner.ts");
        const intent = classifyIntent(appendUser);
        const hints: Record<string, string> = {
          SIMPLE: "responda conversacionalmente, sem ferramentas",
          TOOL: "provavelmente uma única ferramenta resolve",
          PLAN: "vale investigar/analisar antes de agir; proponha um plano se fizer sentido",
          GRAPH: "tarefa multi-etapas: considere graph_plan e, após autorização, graph_execute",
        };
        intentHint = `\nINTENÇÃO SUGERIDA (heurística, não obrigatória): ${intent} — ${hints[intent] ?? ""}.`;
      } catch { intentHint = ""; }
    }
    contextNote = `\n\n--- CONTEXTO DO SECOND BRAIN (${cctx.charBudget.used}/${cctx.charBudget.max} chars) ---\n${cctx.summary ?? "sem contexto específico"}\n${cctx.documents.length ? "\nNotas relevantes: " + cctx.documents.slice(0, 4).map((d) => `[${d.path}] ${d.title}`).join("; ") : ""}\n${cctx.recentEvents.length ? "\nEventos recentes: " + cctx.recentEvents.slice(0, 3).map((e) => e.title).join("; ") : ""}${intentHint}\n--- FIM DO CONTEXTO ---\n\n--- FERRAMENTAS DISPONÍVEIS ---\n${toolList}\n--- FIM DAS FERRAMENTAS ---`;

    const llm = opts.llm ?? this.llm;

    // approval resume: execute the approved tool first, then continue the loop
    let resume = opts.resumeApproval ?? null;
    if (resume) {
      const { toolId, input } = resume;
      const approvedTool = await this.executor.execute({
        toolId,
        input: input ?? {},
        ctx: { config, sessionId: sessionKey, userContext: requestApproval ? { requestApproval } : undefined },
        preApproved: true,
      });
      toolResults.push({ toolId: approvedTool.toolId, success: approvedTool.success, error: approvedTool.error, output: approvedTool.output ?? undefined });
      this.executor.recordEvent(config, { toolId: approvedTool.toolId, success: approvedTool.success, latencyMs: approvedTool.latencyMs, input: input ?? {}, error: approvedTool.error, sessionId: sessionKey, output: approvedTool.output ?? undefined });
      resume = null;
    }

    while (turnCount < this.maxTurns) {
      // Kill switch (cancelamento explícito)
      if (opts.signal?.aborted) {
        const msg = "Interrompido a seu pedido. O que já foi feito está salvo na sessão.";
        persistUser(config, sessionKey, "assistant", msg);
        return { type: "answer", message: { role: "assistant", content: msg }, contextUsed: cctx.charBudget, toolResults };
      }
      // Timeout do loop (evita loop infinito por tempo)
      if (Date.now() - loopStartedAt > this.loopTimeoutMs) {
        const msg = "Interrompi esta execução: atingi o tempo limite sem concluir. Posso retomar de onde parei se você quiser.";
        persistUser(config, sessionKey, "assistant", msg);
        return { type: "answer", message: { role: "assistant", content: msg }, contextUsed: cctx.charBudget, toolResults };
      }
      turnCount++;
      const messages: ChatMessage[] = [
        DEFAULT_SYSTEM,
        { role: "system", content: contextNote },
        ...history,
        { role: "user", content: appendUser },
      ];
      if (toolResults.length) {
        messages.push({
          role: "system",
          content: `Resultado da última ferramenta:\n${JSON.stringify(toolResults.at(-1))?.slice(0, 2000)}`,
        });
      }

      let answer: string;
      try {
        emit({ type: "thinking", detail: "consultando o modelo" });
        const res = await llm(messages);
        answer = res.content ?? "";
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          type: "error",
          toolResults,
          message: { role: "assistant", content: `Não consegui acessar o modelo de IA: ${msg.slice(0, 300)}. Verifique a configuração de chaves (Groq/OpenRouter).` },
        };
      }

      const toolReq = parseToolRequest(answer);
      if (!toolReq) {
        // final textual answer
        const clean = answer.trim();
        const enriched = ensureImageUrls(clean, toolResults);
        emit({ type: "answer" });
        persistUser(config, sessionKey, "assistant", enriched);
        // persist memory (best effort, only if it looks like a fact/decision/idea)
        await persistTurnMemory(config, sessionKey, userText, enriched);
        return { type: "answer", message: { role: "assistant", content: enriched }, contextUsed: cctx.charBudget, toolResults };
      }

      // tool requested
      const toolId = toolReq.tool;
      const toolDef = this.registry.get(toolId);
      if (!toolDef) {
        toolResults.push({ toolId, success: false, error: "ferramenta não registrada" });
        continue;
      }
      // Aprovação ANTES de executar: ferramentas de risco retornam approval_requested
      // imediatamente (NÃO bloqueiam o turno esperando o humano). A execução real
      // acontece via resumeApproval quando o usuário aprova no frontend — sem isso,
      // a imagem nunca era criada: o tool ficava preso aguardando aprovação.
      if (toolDef.requiresApproval && !resume && (opts.deferApproval || !requestApproval)) {
        emit({ type: "approval_requested", toolId });
        return { type: "approval_requested", approval: { toolId, input: toolReq.input ?? {} }, toolResults };
      }
      emit({ type: "tool_start", toolId, graph: toolId.startsWith("graph_") });
      const approvedTool = await this.executor.execute({
        toolId,
        input: toolReq.input ?? {},
        ctx: { config, sessionId: sessionKey, userContext: requestApproval ? { requestApproval } : undefined },
      });
      emit({ type: "tool_result", toolId, success: approvedTool.success, graph: toolId.startsWith("graph_"), output: approvedTool.output ?? undefined });
      this.executor.recordEvent(config, { toolId: approvedTool.toolId, success: approvedTool.success, latencyMs: approvedTool.latencyMs, input: toolReq.input ?? {}, error: approvedTool.error, sessionId: sessionKey, output: approvedTool.output ?? undefined });
      toolResults.push({ toolId: approvedTool.toolId, success: approvedTool.success, error: approvedTool.error, output: approvedTool.output ?? undefined });

      // Detecção de loop: mesma tool+input repetida sem progresso
      const callSig = `${toolId}:${JSON.stringify(toolReq.input ?? {})}`;
      const sigCount = (toolCallSignatures.get(callSig) ?? 0) + 1;
      toolCallSignatures.set(callSig, sigCount);
      if (sigCount >= this.maxRepeatedToolCalls) {
        const msg = `Parei de propósito: a ferramenta "${toolId}" foi chamada ${sigCount} vezes com a mesma entrada sem progresso. Vou resumir o que obtive e você decide o próximo passo.`;
        persistUser(config, sessionKey, "assistant", msg);
        return { type: "answer", message: { role: "assistant", content: msg }, contextUsed: cctx.charBudget, toolResults };
      }
      // Detecção de falha persistente da mesma ferramenta
      if (!approvedTool.success) {
        const streak = (toolFailureStreak.get(toolId) ?? 0) + 1;
        toolFailureStreak.set(toolId, streak);
        if (streak >= this.maxPersistentFailures) {
          const msg = `A ferramenta "${toolId}" falhou ${streak} vezes seguidas (${(approvedTool.error ?? "erro").slice(0, 140)}). Interrompi para não insistir no erro. Posso tentar outra abordagem se quiser.`;
          persistUser(config, sessionKey, "assistant", msg);
          return { type: "answer", message: { role: "assistant", content: msg }, contextUsed: cctx.charBudget, toolResults };
        }
      } else {
        toolFailureStreak.set(toolId, 0);
      }
      // loop continues: appends tool result to context for next LLM call
    }

    const stop = "Atingi o limite de iterações autonomamente sem chegar a uma resposta final. Pode refazer de outra forma?";
    persistUser(config, sessionKey, "assistant", stop);
    return { type: "answer", message: { role: "assistant", content: stop }, contextUsed: cctx.charBudget, toolResults };
  }
}

/** Garante que URLs de imagem gerada (image_generate) apareçam na resposta
 *  final — o frontend renderiza como <img> inline (estética ChatGPT). */
function ensureImageUrls(answer: string, toolResults: ChatTurnResult["toolResults"]): string {
  const urls: string[] = [];
  for (const t of toolResults ?? []) {
    if (t.toolId === "image_generate" && t.success) {
      const out = t.output as { urls?: unknown } | undefined;
      const list = out?.urls;
      if (typeof list === "string") urls.push(list);
      else if (Array.isArray(list)) for (const u of list) if (typeof u === "string") urls.push(u);
    }
  }
  if (!urls.length) return answer;
  const missing = urls.filter((u) => !answer.includes(u));
  if (!missing.length) return answer;
  return answer + "\n\n" + missing.join("\n");
}

async function openLedger(): Promise<import("node:sqlite").DatabaseSync | null> {
  try {
    const { loadConfig } = await import("../config/loader.ts");
    const { openDatabase, applySchema } = await import("../../storage/connection.ts");
    const cfg = loadConfig();
    const db = openDatabase(cfg.dbPath);
    applySchema(db);
    return db;
  } catch {
    return null;
  }
}

/**
 * Persists a memory for meaningful conversation outcomes, with provenance.
 * Conservative: only when the user message signals a decision/idea/preference/goal.
 */
async function persistTurnMemory(config: BrainConfig, sessionKey: string, userText: string, answer: string): Promise<void> {
  const text = `${userText} ${answer}`;
  const signals: Array<{ re: RegExp; category: string; kind: string }> = [
    { re: /\b(decid[io]|vamos\s+fazer|vamos\s+abandonar|escolhi|optamos|prefiro)\b/i, category: "DECISION", kind: "decision" },
    { re: /\b(pensando em|quero|queria|ideia|pretendo|vou come[çc]ar)\b/i, category: "IDEA", kind: "semantic" },
    { re: /\b(prefiro|gosto (mais|de)|n[ãa]o gosto)\b/i, category: "PREFERENCE", kind: "semantic" },
    { re: /\b(foco|focar em|prioridade|estrat[ée]gia|come[çc]ar a vender)\b/i, category: "GOAL", kind: "semantic" },
  ];
  const hit = signals.find((s) => s.re.test(text));
  if (!hit) return;
  try {
    const { openDatabase } = await import("../../storage/connection.ts");
    const { createMemory } = await import("../memory/memory-engine.ts");
    const db = openDatabase(config.dbPath);
    try {
      createMemory(db, {
        content: `[sessão ${sessionKey}] ${userText}`.slice(0, 500),
        memoryKind: hit.kind,
        category: hit.category,
        confidence: 0.75,
      });
    } finally {
      db.close();
    }
  } catch {
    // best-effort persistence
  }
}

export { createDefaultRegistry };
export type { ToolRegistry };
