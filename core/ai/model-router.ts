import { DatabaseSync } from "node:sqlite";
import type { CompletionRequest, CompletionResult, LLMProvider } from "./llm-provider.ts";

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

function inferWorkload(input: ModelSelection): ModelWorkload {
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

export interface GatewayResult extends CompletionResult { provider: string; latencyMs: number; totalTokens?: number; cost?: number; fallbackFrom?: string; }
export async function completeWithGateway(db: DatabaseSync | null, request: CompletionRequest, selection: ModelSelection = {}, providers?: LLMProvider[]): Promise<GatewayResult> {
  const route = selectModel(selection); const available = providers ?? [new OpenRouterProvider(route)]; const started = Date.now(); let lastError: unknown;
  for (let i = 0; i < available.length; i++) {
    const provider = available[i]!;
    try { const result = await provider.complete(request); const latencyMs = Date.now() - started; if (db) db.prepare("INSERT INTO model_generations (provider,model,status,prompt_tokens,completion_tokens,total_tokens,latency_ms,fallback_from,error) VALUES (?,?,?,?,?,?,?,?,?)").run(provider.name, result.model, "COMPLETED", result.tokensPrompt ?? null, result.tokensCompletion ?? null, (result.tokensPrompt ?? 0) + (result.tokensCompletion ?? 0), latencyMs, i ? route.model : null, null); return { ...result, provider: provider.name, latencyMs, totalTokens: (result.tokensPrompt ?? 0) + (result.tokensCompletion ?? 0), fallbackFrom: i ? route.model : undefined }; } catch (error) { lastError = error; }
  }
  if (db) db.prepare("INSERT INTO model_generations (provider,model,status,latency_ms,error) VALUES (?,?,?,?,?)").run(route.provider, route.model, "FAILED", Date.now() - started, String(lastError));
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
