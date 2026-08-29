/**
 * Anthropic-compatible provider (used with Nexxus proxy or direct Anthropic API).
 * Supports the Anthropic Messages API format.
 */

import type { CompletionRequest, CompletionResult, LLMProvider } from "./llm-provider.ts";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  defaultModel?: string;
  anthropicVersion?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; source?: { type: string; media_type: string; data: string } }>;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  temperature?: number;
  stream?: boolean;
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: "assistant";
  model: string;
  content: Array<{ type: string; text?: string; thinking?: string }>;
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
}

const DEFAULT_BASE_URL = "https://api.anthropic.com";
const DEFAULT_MODEL = "claude-sonnet-5";
const DEFAULT_VERSION = "2023-06-01";

export class AnthropicProvider implements LLMProvider {
  readonly name = "anthropic";
  readonly model: string;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly anthropicVersion: string;

  constructor(options: AnthropicProviderOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    this.baseUrl = (options.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = options.model ?? process.env.ANTHROPIC_MODEL ?? options.defaultModel ?? DEFAULT_MODEL;
    this.anthropicVersion = options.anthropicVersion ?? DEFAULT_VERSION;

    if (!this.apiKey) {
      // Soft warning — isAvailable() will return false.
      console.warn(`[anthropic] ANTHROPIC_API_KEY not set; provider disabled.`);
    }
  }

  async isAvailable(): Promise<boolean> {
    return Boolean(this.apiKey);
  }

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    if (!this.apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

    const { system, messages } = extractSystem(request.messages);
    const model = request.model ?? this.model;
    const body: AnthropicRequest = {
      model,
      max_tokens: request.maxTokens ?? 1024,
      messages: messages as AnthropicMessage[],
      ...(system ? { system } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
    };

    const url = `${this.baseUrl}/v1/messages`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": this.anthropicVersion,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(`Anthropic API ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = (await response.json()) as AnthropicResponse;

    // Extract text content from response
    const textContent = data.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");

    return {
      content: textContent || "",
      model: data.model ?? model,
      tokensPrompt: data.usage?.input_tokens,
      tokensCompletion: data.usage?.output_tokens,
    };
  }
}

function extractSystem(messages: Array<{ role: string; content: string }>): {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
} {
  let system: string | undefined;
  const filtered: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else if (m.role === "user" || m.role === "assistant") {
      filtered.push({ role: m.role, content: m.content });
    }
  }

  return { system, messages: filtered };
}

/**
 * Factory for the Anthropic provider — uses Nexxus if ANTHROPIC_BASE_URL is set,
 * otherwise uses the official Anthropic API.
 */
export function createAnthropicProvider(): AnthropicProvider {
  return new AnthropicProvider({});
}