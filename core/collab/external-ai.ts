import { redactSecrets } from "../exec/redact.ts";
import type { LLMProvider } from "../ai/llm-provider.ts";

export interface ExternalAIRequest {
  question: string;
  contextPieces?: string[];
  constraints?: string[];
  requestedOutput?: "answer" | "proposal" | "critique" | "architecture_review" | "second_opinion";
}

export interface ExternalAIResponse {
  answer: string;
  recommendations: string[];
  risks: string[];
  confidence: number;
  provider: string;
  model: string;
}

const MIN_NEEDED_CONTEXT_CAP = 2000;

export function buildConsultationContext(pieces: Array<{ label: string; content: string }>): string[] {
  return pieces.map((p) => {
    const content = p.content.length > MIN_NEEDED_CONTEXT_CAP
      ? `${p.content.slice(0, MIN_NEEDED_CONTEXT_CAP - 3)}…`
      : p.content;
    return `[${p.label}] ${redactSecrets(content)}`;
  });
}

export class FakeExternalAIProvider {
  readonly name = "fake-external-ai";
  readonly model = "fake-model";

  async consult(
    request: ExternalAIRequest,
    contextPieces: string[],
    llmProvider: LLMProvider,
  ): Promise<ExternalAIResponse> {
    void contextPieces;
    const result = await llmProvider.complete({
      messages: [
        { role: "system", content: "Responda de forma concisa em português." },
        { role: "user", content: request.question },
      ],
      maxTokens: 200,
    });
    return {
      answer: result.content,
      recommendations: [],
      risks: [],
      confidence: 0.6,
      provider: this.name,
      model: this.model,
    };
  }
}

export class OpenAICompatProvider {
  readonly name = "openai-compatible";
  readonly model: string;
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(options?: { baseUrl?: string; apiKey?: string; model?: string }) {
    this.baseUrl = options?.baseUrl ?? process.env.SECOND_BRAIN_EXTERNAL_AI_URL ?? "https://api.openai.com/v1";
    this.apiKey = options?.apiKey ?? process.env.SECOND_BRAIN_EXTERNAL_AI_KEY ?? "";
    this.model = options?.model ?? "gpt-4o-mini";
  }

  async consult(request: ExternalAIRequest, contextPieces: string[]): Promise<ExternalAIResponse> {
    if (!this.apiKey) {
      return {
        answer: "IA externa não configurada. Defina SECOND_BRAIN_EXTERNAL_AI_URL e SECOND_BRAIN_EXTERNAL_AI_KEY.",
        recommendations: [],
        risks: ["provider não configurado"],
        confidence: 0,
        provider: this.name,
        model: this.model,
      };
    }
    const systemPrompt = `Você é um consultor especialista do Second Brain OS. Use o contexto fornecido. Responda em português.`;
    const userContent = [
      request.question,
      ...(request.contextPieces ?? []),
      ...(contextPieces ?? []),
    ].join("\n\n");

    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: redactSecrets(userContent) },
        ],
        max_tokens: 500,
      }),
      signal: AbortSignal.timeout(60000),
    });

    if (!res.ok) {
      return {
        answer: `Erro HTTP ${res.status}`,
        recommendations: [],
        risks: [`HTTP ${res.status}`],
        confidence: 0,
        provider: this.name,
        model: this.model,
      };
    }
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return {
      answer: data.choices?.[0]?.message?.content ?? "",
      recommendations: [],
      risks: [],
      confidence: 0.7,
      provider: this.name,
      model: this.model,
    };
  }
}
