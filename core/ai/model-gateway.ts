/**
 * MODEL GATEWAY — camada única de acesso a providers externos (FASE Groq+Alibaba).
 *
 * SingleAgent → ModelGateway → ProviderAdapter(Groq | Alibaba/Qwen | OpenRouter).
 *
 * Regras:
 *  - O Single Agent NUNCA conhece Groq/Alibaba diretamente; fala com o gateway.
 *  - Rotação inteligente de chaves Groq (GROQ_API_KEY_1..10 + GROQ_API_KEY),
 *    com estado por chave (healthy/rate_limited/cooldown/disabled) — reutiliza
 *    o `GroqKeyPool` existente.
 *  - Fallback configurável via MODEL_PROVIDER_ORDER (ex.: groq,alibaba,openrouter).
 *  - Erro permanente de config (401/403) NÃO causa rotação infinita: marca
 *    chave/provider como inválido. 429 → cooldown. 5xx/timeout → retry limitado.
 *  - NUNCA loga chave/token; registra apenas provider/model/keySlot/latency/tokens.
 */

import type { CompletionRequest, CompletionResult, LLMProvider } from "./llm-provider.ts";
import { GroqKeyPool, classifyError } from "./groq-key-pool.ts";

// ── Config de ambiente (sem hardcode de modelo espalhado) ────────────────

export interface GatewayEnv {
  groqKeys: string[];
  groqModel: string;
  groqBaseUrl: string;
  alibabaApiKey: string;
  alibabaBaseUrl: string;
  alibabaModel: string;
  openrouterApiKey: string;
  openrouterBaseUrl: string;
  openrouterModel: string;
  order: string[];
}

/** Lê as chaves Groq de GROQ_API_KEY_1..10 (ignora vazias) com fallback GROQ_API_KEY. */
export function loadGatewayGroqKeys(env: NodeJS.ProcessEnv = process.env): string[] {
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const k = env[`GROQ_API_KEY_${i}`];
    if (k && k.trim()) keys.push(k.trim());
  }
  if (keys.length === 0 && env.GROQ_API_KEY) keys.push(env.GROQ_API_KEY.trim());
  return keys;
}

/** Ordem dos providers via MODEL_PROVIDER_ORDER (default: groq,alibaba,openrouter). */
export function parseProviderOrder(raw?: string): string[] {
  const src = (raw ?? process.env.MODEL_PROVIDER_ORDER ?? "groq,alibaba,openrouter").toLowerCase();
  const order = src.split(",").map((s) => s.trim()).filter(Boolean);
  return order.length ? order : ["groq", "alibaba", "openrouter"];
}

export function readGatewayEnv(env: NodeJS.ProcessEnv = process.env): GatewayEnv {
  return {
    groqKeys: loadGatewayGroqKeys(env),
    groqModel: env.GROQ_MODEL ?? env.SECOND_BRAIN_GROQ_MODEL ?? "openai/gpt-oss-120b",
    groqBaseUrl: env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1",
    alibabaApiKey: env.ALIBABA_API_KEY ?? env.DASHSCOPE_API_KEY ?? "",
    alibabaBaseUrl: env.ALIBABA_BASE_URL ?? env.DASHSCOPE_BASE_URL ?? "https://dashscope.aliyuncs.com/compatible-mode/v1",
    alibabaModel: env.ALIBABA_MODEL ?? env.DASHSCOPE_MODEL ?? "",
    openrouterApiKey: env.OPENROUTER_API_KEY ?? "",
    openrouterBaseUrl: env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/api/v1",
    openrouterModel: env.OPENROUTER_MODEL ?? "openai/gpt-4.1-mini",
    order: parseProviderOrder(env.MODEL_PROVIDER_ORDER),
  };
}

// ── Alibaba/Qwen: seleção de modelo por workload ───────────────────────
// Modelos reais do DashScope (Model Studio). NUNCA inventar id — estes são os
// modelos documentados. ALIBABA_MODEL (se preenchido) sobrepõe para todos;
// vazio → escolha automática por workload (cada agente usa o modelo adequado).
export type QwenWorkload = "fast" | "chat" | "reasoning" | "research" | "coding" | "vision" | "image";

export const QWEN_MODELS_BY_WORKLOAD: Record<QwenWorkload, string> = {
  fast: "qwen-turbo",        // classificação/resp. rápida e barata
  chat: "qwen-plus",         // conversa equilibrada
  reasoning: "qwen-max",     // planejamento/raciocínio
  research: "qwen-long",     // contexto amplo p/ pesquisa
  coding: "qwen-max",        // implementação/revisão de código
  vision: "qwen-vl-max",     // imagem/visão
  image: "qwen-plus",        // fallback (chat-completions não gera imagem)
};

/** Resolve o modelo Alibaba/Qwen: ALIBABA_MODEL explícito > por workload > default. */
export function resolveAlibabaModel(workload?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.ALIBABA_MODEL ?? env.DASHSCOPE_MODEL ?? "";
  if (explicit.trim()) return explicit.trim();
  const key = (workload ?? "chat") as QwenWorkload;
  return QWEN_MODELS_BY_WORKLOAD[key] ?? QWEN_MODELS_BY_WORKLOAD.chat;
}

// ── Adapter genérico OpenAI-compatible (Alibaba/OpenRouter/Groq single) ──

export interface OpenAIAdapterOptions {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  extraHeaders?: Record<string, string>;
}

export class OpenAICompatibleAdapter implements LLMProvider {
  readonly name: string;
  readonly model: string;
  protected readonly baseUrl: string;
  protected readonly apiKey: string;
  protected readonly timeoutMs: number;
  protected readonly extraHeaders: Record<string, string>;
  /** último slot/tag usado (observabilidade; nunca a chave) */
  lastKeySlot: number | null = null;

  constructor(opts: OpenAIAdapterOptions) {
    this.name = opts.name;
    this.model = opts.model;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.extraHeaders = opts.extraHeaders ?? {};
  }

  async isAvailable(): Promise<boolean> { return Boolean(this.apiKey); }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) throw tagged(`${this.name}: API key não configurada`, 401);
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json", ...this.extraHeaders },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? 512,
        temperature: request.temperature ?? 0.2,
        response_format: request.jsonMode ? { type: "json_object" } : undefined,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await res.json().catch(() => ({})) as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string; reasoning?: string | object } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      model?: string;
    };
    if (!res.ok) {
      const msg = data?.error?.message ?? JSON.stringify(data).slice(0, 200);
      throw tagged(`${this.name} HTTP ${res.status}: ${msg}`, res.status);
    }
    let content = data.choices?.[0]?.message?.content ?? "";
    if (!content) {
      const reasoning = data.choices?.[0]?.message?.reasoning;
      if (typeof reasoning === "string") content = reasoning;
      else if (reasoning && typeof reasoning === "object") content = JSON.stringify(reasoning);
    }
    return { content, model: data.model ?? this.model, tokensPrompt: data.usage?.prompt_tokens, tokensCompletion: data.usage?.completion_tokens };
  }
}

function tagged(message: string, status: number): Error & { status?: number } {
  const e = new Error(message) as Error & { status?: number };
  e.status = status;
  return e;
}

/** Provider Alibaba/Qwen (DashScope OpenAI-compatible).
 *  Modelo NUNCA inventado: ALIBABA_MODEL explícito OU escolha por workload
 *  (cada agente usa o modelo Qwen adequado — ver QWEN_MODELS_BY_WORKLOAD). */
export class AlibabaProvider extends OpenAICompatibleAdapter {
  constructor(opts: { apiKey?: string; baseUrl?: string; model?: string; workload?: string; timeoutMs?: number } = {}) {
    const env = readGatewayEnv();
    super({
      name: "alibaba",
      baseUrl: opts.baseUrl ?? env.alibabaBaseUrl,
      apiKey: opts.apiKey ?? env.alibabaApiKey,
      model: opts.model ?? resolveAlibabaModel(opts.workload),
      timeoutMs: opts.timeoutMs,
    });
  }
  async isAvailable(): Promise<boolean> { return Boolean(this.apiKey) && Boolean(this.model); }
}

/** Provider Groq com pool de chaves (rotação/cooldown/retry do GroqKeyPool). */
export class GroqGatewayProvider implements LLMProvider {
  readonly name = "groq";
  readonly model: string;
  readonly pool: GroqKeyPool;
  lastKeySlot: number | null = null;
  constructor(opts: { keys?: string[]; model?: string; baseUrl?: string; cooldownMs?: number; maxRetries?: number; timeoutMs?: number } = {}) {
    const env = readGatewayEnv();
    this.model = opts.model ?? env.groqModel;
    this.pool = new GroqKeyPool({
      keys: opts.keys ?? env.groqKeys,
      model: this.model,
      baseUrl: opts.baseUrl ?? env.groqBaseUrl,
      cooldownMs: opts.cooldownMs,
      maxRetries: opts.maxRetries,
      timeoutMs: opts.timeoutMs,
    });
  }
  async isAvailable(): Promise<boolean> { return this.pool.size > 0; }
  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const { result, slotUsed } = await this.pool.complete(request);
    this.lastKeySlot = slotUsed;
    return result;
  }
}

// ── Cadeia de providers (ordem configurável) ─────────────────────────────

export interface BuildChainOptions {
  env?: NodeJS.ProcessEnv;
  /** Sobrescreve o modelo Groq (ex.: rota por workload). */
  groqModel?: string;
  /** Workload atual — usado para escolher o modelo Qwen por agente. */
  workload?: string;
  /** Permite injetar providers prontos (testes). */
  overrides?: Partial<Record<"groq" | "alibaba" | "openrouter", LLMProvider | null>>;
}

/** Monta a cadeia na ordem MODEL_PROVIDER_ORDER. Chaves vazias → provider omitido. */
export function buildProviderChain(opts: BuildChainOptions = {}): LLMProvider[] {
  const env = readGatewayEnv(opts.env ?? process.env);
  const order = env.order;
  const chain: LLMProvider[] = [];
  for (const name of order) {
    const override = opts.overrides?.[name as "groq" | "alibaba" | "openrouter"];
    if (override === null) continue; // explicitamente desabilitado
    if (override) { chain.push(override); continue; }
    if (name === "groq") {
      if (env.groqKeys.length > 0) chain.push(new GroqGatewayProvider({ keys: env.groqKeys, model: opts.groqModel ?? env.groqModel, baseUrl: env.groqBaseUrl }));
    } else if (name === "alibaba" || name === "qwen" || name === "dashscope") {
      // ALIBABA_MODEL pode ficar vazio → modelo escolhido por workload
      if (env.alibabaApiKey) chain.push(new AlibabaProvider({ apiKey: env.alibabaApiKey, baseUrl: env.alibabaBaseUrl, workload: opts.workload }));
    } else if (name === "openrouter") {
      if (env.openrouterApiKey) chain.push(new OpenAICompatibleAdapter({ name: "openrouter", baseUrl: env.openrouterBaseUrl, apiKey: env.openrouterApiKey, model: env.openrouterModel }));
    }
  }
  return chain;
}

// ── Métricas de execução (nunca expõem chave) ────────────────────────────

export interface GatewayAttemptMetric {
  provider: string;
  model: string;
  keySlot: number | null;
  status: "success" | "failed";
  errorCategory: string | null;
  latencyMs: number;
  tokensPrompt?: number;
  tokensCompletion?: number;
}

export interface GatewayOutcome extends CompletionResult {
  provider: string;
  keySlot: number | null;
  latencyMs: number;
  fallbackCount: number;
  attempts: GatewayAttemptMetric[];
}

/**
 * ModelGateway — percorre a cadeia com fallback controlado e coleta evidência.
 * Erro permanente (401/403) desabilita a chave/provider; 429 entra em cooldown;
 * 5xx/timeout tenta a próxima. Se todos falharem, lança o último erro (sem fake).
 */
export class ModelGateway {
  private readonly providers: LLMProvider[];
  constructor(providers?: LLMProvider[], opts: BuildChainOptions = {}) {
    this.providers = providers ?? buildProviderChain(opts);
  }

  get chainNames(): string[] { return this.providers.map((p) => p.name); }

  async complete(request: CompletionRequest): Promise<GatewayOutcome> {
    if (this.providers.length === 0) throw new Error("ModelGateway: nenhum provider configurado (defina GROQ_API_KEY_n / ALIBABA_API_KEY / OPENROUTER_API_KEY)");
    const attempts: GatewayAttemptMetric[] = [];
    let lastError: unknown;
    let fallbackCount = 0;
    const startedAll = Date.now();
    for (let i = 0; i < this.providers.length; i++) {
      const provider = this.providers[i]!;
      const started = Date.now();
      try {
        if (!(await provider.isAvailable())) {
          attempts.push({ provider: provider.name, model: provider.model, keySlot: null, status: "failed", errorCategory: "UNAVAILABLE", latencyMs: Date.now() - started });
          continue;
        }
        const result = await provider.complete(request);
        const keySlot = (provider as { lastKeySlot?: number | null }).lastKeySlot ?? null;
        attempts.push({ provider: provider.name, model: result.model, keySlot, status: "success", errorCategory: null, latencyMs: Date.now() - started, tokensPrompt: result.tokensPrompt, tokensCompletion: result.tokensCompletion });
        return { ...result, provider: provider.name, keySlot, latencyMs: Date.now() - startedAll, fallbackCount, attempts };
      } catch (err) {
        const status = (err as { status?: number }).status ?? null;
        const category = classifyError(status, err);
        const keySlot = (provider as { lastKeySlot?: number | null }).lastKeySlot ?? null;
        attempts.push({ provider: provider.name, model: provider.model, keySlot, status: "failed", errorCategory: category, latencyMs: Date.now() - started });
        lastError = err;
        if (i < this.providers.length - 1) fallbackCount++;
      }
    }
    // todos falharam
    const e = lastError instanceof Error ? lastError : new Error(String(lastError));
    (e as Error & { attempts?: GatewayAttemptMetric[] }).attempts = attempts;
    throw e;
  }
}
