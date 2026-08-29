import { DatabaseSync } from "node:sqlite";
import type { CompletionRequest, CompletionResult, LLMProvider } from "./llm-provider.ts";
import { GroqKeyPool, classifyError } from "./groq-key-pool.ts";
import { buildProviderChain, loadGatewayGroqKeys } from "./model-gateway.ts";
import { AnthropicProvider } from "./anthropic-provider.ts";

export type ModelWorkload = "chat" | "reasoning" | "research" | "coding" | "vision" | "image" | "fast";
export interface ModelRoute { provider: string; model: string; reason: string; estimatedCost: number | null; fallbackChain: string[]; }
export interface ModelSelection { agent?: string; task?: string; workload?: ModelWorkload; complexity?: "low" | "medium" | "high"; latencyBudgetMs?: number; costBudget?: number; requiredCapabilities?: string[]; }

const ROUTES: Record<ModelWorkload, { model: string; fallbacks: string[]; reason: string }> = {
  fast: { model: "openai/gpt-4.1-nano", fallbacks: ["openai/gpt-4.1-mini", "google/gemini-3.7-flash"], reason: "classificação rápida" },
  chat: { model: "openai/gpt-4.1-mini", fallbacks: ["openai/gpt-4.1", "google/gemini-3.7-flash"], reason: "conversa de baixa latência" },
  reasoning: { model: "openai/gpt-4.1", fallbacks: ["anthropic/claude-sonnet-5", "google/gemini-3.7-flash"], reason: "planejamento e raciocínio" },
  research: { model: "google/gemini-3.7-flash", fallbacks: ["openai/gpt-4.1-mini"], reason: "pesquisa com contexto amplo" },
  coding: { model: "openai/gpt-4.1", fallbacks: ["anthropic/claude-sonnet-5"], reason: "implementação e revisão de código" },
  vision: { model: "openai/gpt-4.1", fallbacks: ["google/gemini-3.7-flash"], reason: "imagem e visão" },
  image: { model: "openai/gpt-image-1", fallbacks: [], reason: "geração de imagem" },
};

export function selectModel(input: ModelSelection): ModelRoute {
  const workload = input.workload ?? inferWorkload(input);
  const route = ROUTES[workload];
  const model = process.env.SECOND_BRAIN_MODEL ?? route.model;
  return { provider: process.env.SECOND_BRAIN_MODEL_PROVIDER ?? "openrouter", model, reason: route.reason, estimatedCost: input.costBudget ?? null, fallbackChain: route.fallbacks };
}

export function inferWorkload(input: ModelSelection): ModelWorkload {
  const text = `${input.agent ?? ""} ${input.task ?? ""}`.toLowerCase();
  if (input.requiredCapabilities?.some((c) => /image|vision|audio/i.test(c))) return "vision";
  if (/code|coding|engineer|developer|test|debug/i.test(text)) return "coding";
  if (/research|search|source|web/i.test(text)) return "research";
  if (/plan|manager|reason|evaluate/i.test(text)) return "reasoning";
  if (input.complexity === "low" || input.latencyBudgetMs !== undefined && input.latencyBudgetMs < 5000) return "fast";
  return "chat";
}

interface OpenRouterResponse { id?: string; model?: string; choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number } }
export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fallbackModels: string[];
  constructor(route = selectModel({}), options: { apiKey?: string; baseUrl?: string } = {}) { this.model = route.model; this.fallbackModels = route.fallbackChain; this.apiKey = options.apiKey ?? process.env.OPENROUTER_API_KEY ?? ""; this.baseUrl = options.baseUrl ?? "https://openrouter.ai/api/v1"; }
  async isAvailable(): Promise<boolean> { return Boolean(this.apiKey); }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) throw new Error("OPENROUTER_API_KEY not configured");
    const response = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", "X-Title": "Second Brain OS" }, body: JSON.stringify({ model: this.model, models: [this.model, ...this.fallbackModels], route: "fallback", messages: request.messages, max_tokens: request.maxTokens ?? 512, temperature: request.temperature ?? 0.2, response_format: request.jsonMode ? { type: "json_object" } : undefined }), signal: AbortSignal.timeout(120_000) });
    const data = await response.json() as OpenRouterResponse;
    if (!response.ok) throw new Error(`openrouter HTTP ${response.status}: ${JSON.stringify(data).slice(0, 300)}`);
    return { content: data.choices?.[0]?.message?.content ?? "", model: data.model ?? this.model, tokensPrompt: data.usage?.prompt_tokens, tokensCompletion: data.usage?.completion_tokens };
  }
}

/** Groq (OpenAI-compatible, ultra-fast). Usado automaticamente quando GROQ_API_KEY existe. */
export class GroqProvider implements LLMProvider {
  readonly name = "groq";
  readonly model: string;
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.groq.com/openai/v1";
  constructor(options: { apiKey?: string; model?: string } = {}) {
    this.model = options.model ?? process.env.SECOND_BRAIN_GROQ_MODEL ?? "openai/gpt-oss-120b";
    this.apiKey = options.apiKey ?? process.env.GROQ_API_KEY ?? "";
  }
  async isAvailable(): Promise<boolean> { return Boolean(this.apiKey); }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) throw new Error("GROQ_API_KEY not configured");
    const response = await fetch(`${this.baseUrl}/chat/completions`, { method: "POST", headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: this.model, messages: request.messages, max_tokens: request.maxTokens ?? 512, temperature: request.temperature ?? 0.2, response_format: request.jsonMode ? { type: "json_object" } : undefined }), signal: AbortSignal.timeout(60_000) });
    const data = await response.json() as OpenRouterResponse & { error?: { message?: string } };
    if (!response.ok) throw new Error(`groq HTTP ${response.status}: ${JSON.stringify(data.error ?? data).slice(0, 300)}`);
    return { content: data.choices?.[0]?.message?.content ?? "", model: data.model ?? this.model, tokensPrompt: data.usage?.prompt_tokens, tokensCompletion: data.usage?.completion_tokens };
  }
}

/** Carrega as chaves Groq de GROQ_API_KEY_1..N (até 10; fallback: GROQ_API_KEY única). Usa apenas as preenchidas.
 *  Delega para o Model Gateway (fonte única). */
export function loadGroqKeys(): string[] {
  return loadGatewayGroqKeys();
}

/** Provider Groq com pool de chaves — rotação/cooldown/retry automáticos. */
export class GroqPoolProvider implements LLMProvider {
  readonly name = "groq";
  readonly model: string;
  readonly pool: GroqKeyPool;
  constructor(options: { keys?: string[]; model?: string; baseUrl?: string } = {}) {
    const model = options.model ?? process.env.GROQ_MODEL ?? process.env.SECOND_BRAIN_GROQ_MODEL ?? "openai/gpt-oss-120b";
    this.model = model;
    this.pool = new GroqKeyPool({ keys: options.keys ?? loadGroqKeys(), model, baseUrl: options.baseUrl });
  }
  async isAvailable(): Promise<boolean> { return this.pool.size > 0; }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { result } = await this.pool.complete(request);
    return result;
  }
}

/**
 * Cadeia de providers padrão:
 *   1. Anthropic (Nexxus ou API direta) — primário
 *   2. Groq pool — fallback rápido
 *   3. OpenRouter — fallback final
 *
 * O workload escolhe o modelo (claude-sonnet-5, claude-haiku-4-5, etc).
 *  Nunca esconde erro do provider. */
export function defaultProviderChain(route = selectModel({}), workload?: string): LLMProvider[] {
  const chain: LLMProvider[] = [];

  // 1. Anthropic/Nexxus como primário se tiver chave
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const modelByWorkload: Record<string, string> = {
      fast: "claude-haiku-4-5",
      chat: "claude-sonnet-5",
      reasoning: "claude-sonnet-5",
      research: "claude-sonnet-5",
      coding: "claude-sonnet-5",
      vision: "claude-sonnet-5",
      image: "claude-sonnet-5",
    };
    const model = modelByWorkload[workload ?? "chat"] ?? process.env.ANTHROPIC_MODEL ?? "claude-sonnet-5";
    chain.push(new AnthropicProvider({ model }));
  }

  // 2. Groq pool como fallback
  const gatewayChain = buildProviderChain({ groqModel: process.env.GROQ_MODEL ?? route.model, workload });
  chain.push(...gatewayChain);

  // 3. OpenRouter como fallback final
  if (chain.length === 0) {
    chain.push(new OpenRouterProvider(route));
  }

  return chain;
}

export interface GatewayResult extends CompletionResult { provider: string; latencyMs: number; totalTokens?: number; cost?: number; fallbackFrom?: string; keySlot?: number | null; fallbackCount?: number; }
export async function completeWithGateway(db: DatabaseSync | null, request: CompletionRequest, selection: ModelSelection = {}, providers?: LLMProvider[]): Promise<GatewayResult> {
  const route = selectModel(selection); const workload = selection.workload ?? inferWorkload(selection); const available = providers ?? defaultProviderChain(route, workload); const started = Date.now(); let lastError: unknown; let fallbackCount = 0;
  for (let i = 0; i < available.length; i++) {
    const provider = available[i]!;
    const keySlot = (provider as { lastKeySlot?: number | null }).lastKeySlot ?? null;
    try { const result = await provider.complete(request); const latencyMs = Date.now() - started; const slot = (provider as { lastKeySlot?: number | null }).lastKeySlot ?? keySlot; if (db) db.prepare("INSERT INTO model_generations (provider,model,status,prompt_tokens,completion_tokens,total_tokens,cost,latency_ms,fallback_from,error,key_slot,fallback_count,error_category) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").run(provider.name, result.model, "COMPLETED", result.tokensPrompt ?? null, result.tokensCompletion ?? null, (result.tokensPrompt ?? 0) + (result.tokensCompletion ?? 0), null, latencyMs, i ? route.model : null, null, slot, fallbackCount, null); return { ...result, provider: provider.name, latencyMs, totalTokens: (result.tokensPrompt ?? 0) + (result.tokensCompletion ?? 0), fallbackFrom: i ? route.model : undefined, keySlot: slot, fallbackCount }; } catch (error) { lastError = error; const category = classifyError((error as { status?: number }).status ?? null, error); if (db) { try { db.prepare("INSERT INTO model_generations (provider,model,status,latency_ms,error,key_slot,fallback_count,error_category) VALUES (?,?,?,?,?,?,?,?)").run(provider.name, provider.model, "FAILED", Date.now() - started, redact(String(error)), (provider as { lastKeySlot?: number | null }).lastKeySlot ?? null, fallbackCount, category); } catch {} } if (i < available.length - 1) fallbackCount++; }
  }
  if (db) { try { db.prepare("INSERT INTO model_generations (provider,model,status,latency_ms,error,fallback_count,error_category) VALUES (?,?,?,?,?,?,?)").run(route.provider, route.model, "FAILED_CHAIN", Date.now() - started, redact(String(lastError)), fallbackCount, classifyError((lastError as { status?: number })?.status ?? null, lastError)); } catch {} }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** Remove padrões sensíveis antes de persistir erro (nunca vazar chave/token). */
function redact(text: string): string {
  return text
    .replace(/gsk_[A-Za-z0-9]{10,}/g, "***")
    .replace(/sk-[A-Za-z0-9_-]{16,}/g, "***")
    .replace(/sk-or-v1-[A-Za-z0-9]+/g, "***")
    .replace(/hf_[A-Za-z0-9]+/g, "***")
    .replace(/Bearer\s+[A-Za-z0-9_.\-]{16,}/gi, "Bearer ***");
}
