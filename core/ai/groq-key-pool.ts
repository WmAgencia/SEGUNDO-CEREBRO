import type { CompletionRequest, CompletionResult } from "./llm-provider.ts";

/**
 * GROQ KEY POOL — rotação resiliente de múltiplas chaves Groq (API oficial).
 *
 * Objectivo: disponibilidade/resiliência quando uma chave é rate-limited (429),
 * inválida (401/403) ou falha (5xx/timeout). NUNCA burla rate limit da org —
 * apenas tenta outra chave válida e respeita cooldown.
 *
 * NUNCA expõe a chave completa (só slot id) — API keys ficam privadas.
 */

export type KeyState = "AVAILABLE" | "COOLDOWN" | "FAILED" | "DISABLED";

export interface GroqKeySlot {
  slot: number;        // 1..N — id público, nunca a chave
  state: KeyState;
  cooldownUntil: number | null;
  lastSuccess: number | null;
  lastError: string | null;
  lastStatus: number | null;
  requests: number;
  tokens: number;
  totalLatencyMs: number;
}

export type GroqKeyPoolConfig = {
  keys: string[];                 // chaves reais (privadas)
  model?: string;
  baseUrl?: string;
  cooldownMs?: number;            // cooldown após 429 (tenta validar Retry-After também)
  backoffBaseMs?: number;         // backoff exponencial p/ erros temporários
  maxRetries?: number;            // retries por chamada
  timeoutMs?: number;
};

const DEFAULT_COOLDOWN_MS = 30_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 60_000;

export class GroqKeyPool {
  private readonly slots: GroqKeySlot[];
  private readonly keys: string[];
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly cooldownMs: number;
  private readonly backoffBaseMs: number;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(config: GroqKeyPoolConfig) {
    this.keys = config.keys.filter((k) => k && k.trim() !== "");
    this.slots = this.keys.map((_, i) => ({
      slot: i + 1, state: "AVAILABLE", cooldownUntil: null,
      lastSuccess: null, lastError: null, lastStatus: null,
      requests: 0, tokens: 0, totalLatencyMs: 0,
    }));
    this.model = config.model ?? process.env.GROQ_MODEL ?? process.env.SECOND_BRAIN_GROQ_MODEL ?? "openai/gpt-oss-120b";
    this.baseUrl = config.baseUrl ?? process.env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1";
    this.cooldownMs = config.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.backoffBaseMs = config.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.maxRetries = config.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get size(): number { return this.keys.length; }

  /** Snapshot seguro dos slots (sem chaves). */
  status(): GroqKeySlot[] {
    const now = Date.now();
    return this.slots.map((s) => ({
      ...s,
      state: s.state === "COOLDOWN" && s.cooldownUntil !== null && now >= s.cooldownUntil ? "AVAILABLE" : s.state,
    }));
  }

  /** Escolhe a próxima chave disponível (evita COOLDOWN/FAILED/DISABLED). */
  private nextSlot(): { index: number; slot: GroqKeySlot } | null {
    const now = Date.now();
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.state === "COOLDOWN" && s.cooldownUntil !== null && now >= s.cooldownUntil) { s.state = "AVAILABLE"; s.cooldownUntil = null; }
      if (s.state === "AVAILABLE") return { index: i, slot: s };
    }
    return null;
  }

  /** Rotação com cooldown/backoff/retry. Retorna chave + qual slot usou. */
  async complete(request: CompletionRequest): Promise<{ result: CompletionResult; slotUsed: number; provider: string }> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const next = this.nextSlot();
      if (!next) throw new Error("GroqKeyPool: nenhuma chave disponível (todas em cooldown/falha)");
      const { index, slot } = next;
      const key = this.keys[index]!;
      const started = Date.now();
      try {
        const result = await this.callGroq(key, request);
        const latency = Date.now() - started;
        slot.state = "AVAILABLE"; slot.cooldownUntil = null;
        slot.lastSuccess = Date.now(); slot.lastError = null; slot.lastStatus = 200;
        slot.requests++; slot.tokens += (result.tokensPrompt ?? 0) + (result.tokensCompletion ?? 0); slot.totalLatencyMs += latency;
        return { result, slotUsed: slot.slot, provider: `groq#${slot.slot}` };
      } catch (err) {
        const e = err as { status?: number; message?: string };
        latencyBookkeep(slot, started);
        slot.lastError = e.message ?? String(err);
        slot.lastStatus = e.status ?? null;
        if (e.status === 401 || e.status === 403) {
          slot.state = "DISABLED"; // chave inválida — não usar de novo
        } else if (e.status === 429) {
          slot.state = "COOLDOWN";
          slot.cooldownUntil = Date.now() + this.cooldownMs;
        } else {
          // 5xx / timeout / transient → FAILED com backoff (próxima tentativa usa outra chave)
          slot.state = "FAILED";
          slot.cooldownUntil = Date.now() + this.backoffBaseMs * (attempt + 1);
        }
        lastError = err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async callGroq(key: string, request: CompletionRequest): Promise<CompletionResult> {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages: request.messages,
        max_tokens: request.maxTokens ?? 512,
        temperature: request.temperature ?? 0.2,
        response_format: request.jsonMode ? { type: "json_object" } : undefined,
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await res.json() as {
      error?: { message?: string };
      choices?: Array<{ message?: { content?: string; reasoning?: string | object } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    if (!res.ok) {
      const status = res.status;
      const msg = data?.error?.message ?? JSON.stringify(data).slice(0, 200);
      const err = new Error(`groq HTTP ${status}: ${msg}`) as Error & { status?: number };
      err.status = status;
      throw err;
    }
    let content = data.choices?.[0]?.message?.content ?? "";
    // gpt-oss pode devolver só `reasoning` (deixando content vazio) em prompts
    // curtos — funde o reasoning como fallback para não perder a resposta.
    if (!content) {
      const reasoning = data.choices?.[0]?.message?.reasoning;
      if (typeof reasoning === "string") content = reasoning;
      else if (reasoning && typeof reasoning === "object") content = JSON.stringify(reasoning);
    }
    return {
      content,
      model: this.model,
      tokensPrompt: data.usage?.prompt_tokens,
      tokensCompletion: data.usage?.completion_tokens,
    };
  }
}

function latencyBookkeep(slot: GroqKeySlot, started: number): void {
  slot.requests++;
  slot.totalLatencyMs += Date.now() - started;
}

/** Limpa as chaves antes de qualquer log/serialização (nunca vazar). */
export function redactKeys(keys: string[]): string[] {
  return keys.map((_, i) => `groq#${i + 1}`);
}
