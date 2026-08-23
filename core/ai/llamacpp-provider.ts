import { loadConfig } from "../config/loader.ts";
import type { BrainConfig } from "../config/loader.ts";
import type {
  CompletionRequest,
  CompletionResult,
  LLMProvider,
} from "./llm-provider.ts";

interface ChatChoice {
  message?: { content?: string };
}

interface ChatResponse {
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export interface LlamaCppProviderOptions {
  baseUrl?: string;
  model?: string;
  fetchFn?: typeof fetch;
}

export class LocalLlamaCppProvider implements LLMProvider {
  readonly name = "llamacpp";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: LlamaCppProviderOptions = {}) {
    const config = options.baseUrl ? undefined : loadConfigQuiet();
    this.baseUrl = options.baseUrl ?? config?.ai.baseUrl ?? "http://127.0.0.1:11434";
    this.model = options.model ?? config?.ai.model ?? "qwen3-1.7b";
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      return res.ok || res.status === 200;
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const body: Record<string, unknown> = {
      messages: request.messages,
      max_tokens: request.maxTokens ?? 512,
      temperature: request.temperature ?? 0.2,
      chat_template_kwargs: { enable_thinking: false },
    };
    if (request.jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const res = await this.fetchFn(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });

    if (!res.ok) {
      throw new Error(`llamacpp HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as ChatResponse;
    const choice = data.choices?.[0];
    return {
      content: choice?.message?.content ?? "",
      model: this.model,
      tokensPrompt: data.usage?.prompt_tokens,
      tokensCompletion: data.usage?.completion_tokens,
    };
  }
}

function loadConfigQuiet(): BrainConfig | undefined {
  try {
    return loadConfig();
  } catch {
    return undefined;
  }
}
