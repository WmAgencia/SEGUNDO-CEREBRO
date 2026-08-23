export interface CompletionMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionRequest {
  messages: CompletionMessage[];
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
}

export interface CompletionResult {
  content: string;
  model: string;
  tokensPrompt?: number;
  tokensCompletion?: number;
}

export interface LLMProvider {
  readonly name: string;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  complete(request: CompletionRequest): Promise<CompletionResult>;
}
