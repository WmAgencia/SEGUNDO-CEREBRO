import http from "node:http";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { completeWithGateway, selectModel } from "../core/ai/model-router.ts";
import { redactKeys } from "../core/ai/groq-key-pool.ts";
import type { LLMProvider } from "../core/ai/llm-provider.ts";

/* ── Schema compatível com a tabela REAL do projeto (15 colunas) ─ */

function createLedgerDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.prepare(`CREATE TABLE model_generations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT DEFAULT NULL, task_id INTEGER DEFAULT NULL, agent_id TEXT DEFAULT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    status TEXT NOT NULL,
    prompt_tokens INTEGER DEFAULT NULL,
    completion_tokens INTEGER DEFAULT NULL,
    total_tokens INTEGER DEFAULT NULL,
    cost REAL DEFAULT NULL,
    latency_ms INTEGER DEFAULT NULL,
    fallback_from TEXT DEFAULT NULL,
    error TEXT DEFAULT NULL,
    key_slot INTEGER DEFAULT NULL,
    fallback_count INTEGER DEFAULT NULL,
    error_category TEXT DEFAULT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  )`).run();
  return db;
}

/* ── Testes: Gateway + ledger completo ────────────────────── */

describe("completeWithGateway — cadeia completa com ledger", () => {
  it("sucesso no primeiro provider grava no ledger corretamente", async () => {
    const db = createLedgerDb();

    const mockProvider: LLMProvider = {
      name: "mock-first",
      model: "mock-model-1",
      isAvailable: async () => true,
      complete: async (): Promise<any> => ({ content: "test-response", model: "mock-model-1", tokensPrompt: 5, tokensCompletion: 10 }),
    };

    const result = await completeWithGateway(db, { messages: [{ role: "user", content: "ola" }] }, {}, [mockProvider]);

    expect(result.content).toBe("test-response");
    expect(result.provider).toBe("mock-first");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);

    const rows = db.prepare("SELECT * FROM model_generations").all() as Array<{provider:string;status:string;prompt_tokens:number|null;completion_tokens:number|null}>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.provider).toBe("mock-first");
    expect(rows[0]!.status).toBe("COMPLETED");
    expect(rows[0]!.prompt_tokens).toBe(5);
    expect(rows[0]!.completion_tokens).toBe(10);
    db.close();
  });

  it("falha primeiro provider → tenta segundo (fallback chain)", async () => {
    const db = createLedgerDb();

    let callCount = 0;
    const failing: LLMProvider = {
      name: "failing-provider", model: "broken-model", isAvailable: async () => true,
      complete: async (): Promise<any> => { callCount++; throw new Error("provider falhou"); },
    };
    const working: LLMProvider = {
      name: "working-provider", model: "good-model", isAvailable: async () => true,
      complete: async (): Promise<any> => ({ content: "fallback-ok", model: "good-model" }),
    };

    const result = await completeWithGateway(db, { messages: [{ role: "user", content: "test" }] }, {}, [failing, working]);

    expect(result.content).toBe("fallback-ok");
    expect(result.provider).toBe("working-provider");
    expect(callCount).toBe(1);

    const rows = db.prepare("SELECT provider, status FROM model_generations ORDER BY id").all() as Array<{provider:string;status:string}>;
    expect(rows.length).toBe(2);
    expect(rows[0]!.status).toBe("FAILED");
    expect(rows[1]!.status).toBe("COMPLETED");
    db.close();
  });

  it("todos providers falham → lança erro honesto", async () => {
    const db = createLedgerDb();

    const failing: LLMProvider[] = [
      { name: "fail-1", model: "m1", isAvailable: async () => true, complete: async () => { throw new Error("err1"); } },
      { name: "fail-2", model: "m2", isAvailable: async () => true, complete: async () => { throw new Error("err2"); } },
    ];

    await expect(completeWithGateway(db, { messages: [{ role: "user", content: "x" }] }, {}, failing))
      .rejects.toThrow(/err/i);

    const rows = db.prepare("SELECT count(*) as cnt FROM model_generations WHERE status='FAILED'").get() as { cnt: number };
    expect(rows.cnt).toBe(2); // ambos gravados como FAILED
    db.close();
  });

  it("sem DB não quebra — executa normalmente sem logging", async () => {
    const mock: LLMProvider = {
      name: "no-db-test", model: "test", isAvailable: async () => true,
      complete: async (): Promise<any> => ({ content: "no-db-ok", model: "test" }),
    };

    const result = await completeWithGateway(null, { messages: [{ role: "user", content: "test" }] }, {}, [mock]);
    expect(result.content).toBe("no-db-ok");
    expect(result.provider).toBe("no-db-test");
  });

  it("registro de latência e tokens no ledger", async () => {
    const db = createLedgerDb();

    const mock: LLMProvider = {
      name: "latency-test", model: "test", isAvailable: async () => true,
      complete: async (): Promise<any> => ({ content: "ok", model: "test", tokensPrompt: 12, tokensCompletion: 8 }),
    };

    const start = Date.now();
    await completeWithGateway(db, { messages: [{ role: "user", content: "test" }] }, {}, [mock]);

    const row = db.prepare("SELECT latency_ms, prompt_tokens, completion_tokens FROM model_generations LIMIT 1")
      .get() as { latency_ms:number; prompt_tokens:number|null; completion_tokens:number|null };
    expect(row.latency_ms).toBeGreaterThanOrEqual(0);
    expect(row.prompt_tokens).toBe(12);
    expect(row.completion_tokens).toBe(8);
    db.close();
  });
});

/* ── Workload inference ────────────────────────────────────── */

describe("selectModel — workload inference", () => {
  it("detecta planejamento/reasoning", () => {
    const route = selectModel({ task: "planejar estratégia de prospecção" });
    expect(route.model).toBeDefined();
    expect(route.fallbackChain.length).toBeGreaterThan(0);
  });

  it("detecta código", () => {
    const route = selectModel({ task: "debugar bug no frontend do site" });
    expect(route.reason).toContain("código");
  });

  it("detecta baixa latência", () => {
    const route = selectModel({ latencyBudgetMs: 3000 });
    expect(route.reason).toContain("classificação rápida");
  });
});

/* ── Segurança: nunca expõe chaves ──────────────────────────── */

describe("segurança — nenhuma chave vazada", () => {
  it("redactKeys mascara TODAS as chaves", () => {
    const keys = ["real-secret-key-123", "another-secret-456"];
    const masked = redactKeys(keys);
    expect(masked).toEqual(["groq#1", "groq#2"]);
    const joined = masked.join("");
    expect(joined).not.toContain("secret");
    expect(joined).not.toContain("key-");
    expect(joined).not.toContain("real");
  });
});
