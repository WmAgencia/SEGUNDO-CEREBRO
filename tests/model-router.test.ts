import { describe, expect, it } from "vitest";
import { selectModel, OpenRouterProvider, completeWithGateway } from "../core/ai/model-router.ts";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { CompletionRequest, CompletionResult, LLMProvider } from "../core/ai/llm-provider.ts";

class RecordingProvider implements LLMProvider {
  readonly name = "recording"; readonly model = "test/model";
  async isAvailable(): Promise<boolean> { return true; }
  async complete(_request: CompletionRequest): Promise<CompletionResult> { return { content: "ok", model: this.model, tokensPrompt: 3, tokensCompletion: 2 }; }
}

describe("model gateway", () => {
  it("selects deterministic routes by workload", () => {
    expect(selectModel({ workload: "coding", agent: "engineering" }).reason).toContain("código");
    expect(selectModel({ workload: "research" }).fallbackChain.length).toBeGreaterThan(0);
    expect(selectModel({ workload: "fast", latencyBudgetMs: 1000 }).provider).toBe("openrouter");
  });
  it("reports OpenRouter as unavailable without credential", async () => {
    const provider = new OpenRouterProvider(selectModel({ workload: "chat" }), { apiKey: "" });
    expect(await provider.isAvailable()).toBe(false);
  });
  it("records a successful injected provider generation", async () => {
    const db = openDatabase(":memory:"); applySchema(db);
    const result = await completeWithGateway(db, { messages: [{ role: "user", content: "hello" }] }, { workload: "fast" }, [new RecordingProvider()]);
    expect(result.content).toBe("ok");
    expect((db.prepare("SELECT COUNT(*) AS n FROM model_generations").get() as { n: number }).n).toBe(1);
    db.close();
  });
});
