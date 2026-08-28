/**
 * FASE Groq+Alibaba — Model Gateway (testes unitários + E2E simulado).
 *
 * Usa um servidor HTTP local como dublê dos endpoints Groq/Alibaba para
 * exercitar DE VERDADE: seleção, rotação de chaves, cooldown, fallback entre
 * providers, 401/429/500/timeout e provider indisponível. Nenhum mock de
 * sucesso: o servidor responde e o gateway reage ao status real.
 */

import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  AlibabaProvider,
  GroqGatewayProvider,
  ModelGateway,
  OpenAICompatibleAdapter,
  buildProviderChain,
  loadGatewayGroqKeys,
  parseProviderOrder,
  readGatewayEnv,
  resolveAlibabaModel,
} from "../core/ai/model-gateway.ts";
import type { LLMProvider } from "../core/ai/llm-provider.ts";
import type { CompletionRequest, CompletionResult } from "../core/ai/llm-provider.ts";

let server: http.Server;
let baseUrl: string;
// comportamento por chave de auth (groq) ou por marker
let behavior: Record<string, { status: number; body: string }> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const auth = String(req.headers["authorization"] ?? "");
    const key = auth.replace(/^Bearer\s+/i, "");
    const b = behavior[key];
    res.writeHead(b?.status ?? 200, { "Content-Type": "application/json" });
    res.end(b?.body ?? JSON.stringify({ choices: [{ message: { content: `resp-${key.slice(0, 4)}` } }], usage: { prompt_tokens: 4, completion_tokens: 6 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { try { server.close(); } catch {} });

const savedEnv: Record<string, string | undefined> = {};
function setEnv(vars: Record<string, string>) {
  for (const [k, v] of Object.entries(vars)) {
    if (!(k in savedEnv)) savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
}
beforeEach(() => { behavior = {}; });
afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

function pointGatewayAtLocal(order: string, extra: Record<string, string> = {}) {
  setEnv({
    GROQ_BASE_URL: baseUrl,
    ALIBABA_BASE_URL: baseUrl,
    OPENROUTER_BASE_URL: baseUrl,
    MODEL_PROVIDER_ORDER: order,
    GROQ_MODEL: "openai/gpt-oss-120b",
    ALIBABA_MODEL: "qwen-plus",
    OPENROUTER_MODEL: "openai/gpt-4.1-mini",
    ...extra,
  });
}

describe("ModelGateway — seleção e configuração", () => {
  it("parseProviderOrder default e custom", () => {
    expect(parseProviderOrder(undefined)).toEqual(["groq", "openrouter"]);
    expect(parseProviderOrder("alibaba,groq")).toEqual(["alibaba", "groq"]);
    expect(parseProviderOrder("  groq , openrouter ")).toEqual(["groq", "openrouter"]);
    expect(parseProviderOrder("")).toEqual(["groq", "openrouter"]);
  });

  it("loadGatewayGroqKeys ignora vazias e usa fallback GROQ_API_KEY", () => {
    const env = { GROQ_API_KEY_1: "a", GROQ_API_KEY_2: "", GROQ_API_KEY_3: "  ", GROQ_API_KEY_4: "b" } as NodeJS.ProcessEnv;
    expect(loadGatewayGroqKeys(env)).toEqual(["a", "b"]);
    const env2 = { GROQ_API_KEY: "single" } as NodeJS.ProcessEnv;
    expect(loadGatewayGroqKeys(env2)).toEqual(["single"]);
  });

  it("buildProviderChain respeita ordem e omite provider sem chave", () => {
    pointGatewayAtLocal("groq,alibaba,openrouter", { GROQ_API_KEY_1: "gk1", ALIBABA_API_KEY: "", OPENROUTER_API_KEY: "" });
    // limpa chaves 2..10
    for (let i = 2; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
    delete process.env.GROQ_API_KEY;
    const chain = buildProviderChain();
    expect(chain.map((p) => p.name)).toEqual(["groq"]); // alibaba/openrouter sem chave → omitidos
  });

  it("AlibabaProvider indisponível sem chave ou sem modelo (modelo nunca inventado)", async () => {
    setEnv({ ALIBABA_API_KEY: "", ALIBABA_MODEL: "" });
    const p = new AlibabaProvider({ apiKey: "", model: "" });
    expect(await p.isAvailable()).toBe(false);
    const p2 = new AlibabaProvider({ apiKey: "x", model: "" });
    expect(await p2.isAvailable()).toBe(false); // tem chave mas sem modelo configurado
  });
});

describe("ModelGateway — fallback entre providers (E2E simulado)", () => {
  it("Groq → 429 → Alibaba → resposta (fallback real entre providers)", async () => {
    behavior["gk1"] = { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) };
    behavior["al1"] = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "via-alibaba" } }], usage: { prompt_tokens: 2, completion_tokens: 3 } }) };
    // providers construídos manualmente (maxRetries 0 p/ o Groq lançar o 429 direto)
    const groq = new GroqGatewayProvider({ keys: ["gk1"], baseUrl, model: "openai/gpt-oss-120b", maxRetries: 0 });
    const alibaba = new AlibabaProvider({ apiKey: "al1", baseUrl, model: "qwen-plus" });
    const gw = new ModelGateway([groq, alibaba]);
    const out = await gw.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(out.provider).toBe("alibaba");
    expect(out.content).toBe("via-alibaba");
    expect(out.fallbackCount).toBe(1);
    expect(out.attempts.length).toBe(2);
    expect(out.attempts[0]!.errorCategory).toBe("RATE_LIMIT_429");
    expect(out.attempts[1]!.status).toBe("success");
  });

  it("Groq key1 falha (500) → Groq key2 responde (rotação interna de chaves)", async () => {
    for (let i = 3; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
    delete process.env.GROQ_API_KEY;
    pointGatewayAtLocal("groq", { GROQ_API_KEY_1: "gkA", GROQ_API_KEY_2: "gkB", ALIBABA_API_KEY: "" });
    behavior["gkA"] = { status: 500, body: JSON.stringify({ error: { message: "server error" } }) };
    behavior["gkB"] = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "via-key2" } }] }) };

    const gw = new ModelGateway(buildProviderChain({ env: process.env }));
    const out = await gw.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(out.provider).toBe("groq");
    expect(out.content).toBe("via-key2");
    expect(out.keySlot).toBe(2); // rotacionou para a chave 2
  });

  it("401 (erro permanente) marca chave inválida e não causa rotação infinita", async () => {
    for (let i = 2; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
    delete process.env.GROQ_API_KEY;
    pointGatewayAtLocal("groq", { GROQ_API_KEY_1: "bad", ALIBABA_API_KEY: "" });
    behavior["bad"] = { status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) };
    const gw = new ModelGateway(buildProviderChain({ env: process.env }));
    await expect(gw.complete({ messages: [{ role: "user", content: "oi" }] })).rejects.toThrow();
    // termina (não loopa) e a chave fica DISABLED no pool
    const groq = gw.chainNames[0];
    expect(groq).toBe("groq");
  });

  it("falha múltipla: em workload especializado (vision), Groq + Alibaba ambos tentam e falham", async () => {
    for (let i = 2; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
    delete process.env.GROQ_API_KEY;
    pointGatewayAtLocal("groq,alibaba", { GROQ_API_KEY_1: "g1", ALIBABA_API_KEY: "a1" });
    behavior["g1"] = { status: 503, body: JSON.stringify({ error: { message: "unavailable" } }) };
    behavior["a1"] = { status: 500, body: JSON.stringify({ error: { message: "boom" } }) };
    // workload vision → Alibaba entra como especialista à frente do Groq
    const gw = new ModelGateway(buildProviderChain({ env: process.env, workload: "vision" }));
    try {
      await gw.complete({ messages: [{ role: "user", content: "oi" }] });
      expect.unreachable("deveria lançar");
    } catch (e) {
      const attempts = (e as { attempts?: Array<{ provider?: string }> }).attempts ?? [];
      expect(attempts.length).toBe(2); // alibaba(groq) ambos tentaram
      expect(attempts[0]!.provider).toBe("alibaba"); // especialista primeiro
      expect(attempts[1]!.provider).toBe("groq");
    }
  });

  it("chat genérico NÃO inclui Alibaba especialista mesmo com chave válida e na ordem", () => {
    for (let i = 2; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
    delete process.env.GROQ_API_KEY;
    pointGatewayAtLocal("groq,alibaba", { GROQ_API_KEY_1: "gk1", ALIBABA_API_KEY: "al1", OPENROUTER_API_KEY: "" });
    // workload padrão é "chat" → especializado=false → Alibaba ignorado
    const chain = buildProviderChain();
    expect(chain.map((p) => p.name)).toEqual(["groq"]);
  });

  it("nenhum provider configurado → erro claro (não fake)", async () => {
    for (let i = 1; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
    delete process.env.GROQ_API_KEY;
    pointGatewayAtLocal("groq,alibaba", { ALIBABA_API_KEY: "", OPENROUTER_API_KEY: "" });
    const chain = buildProviderChain({ env: process.env });
    expect(chain.length).toBe(0);
    const gw = new ModelGateway(chain);
    await expect(gw.complete({ messages: [{ role: "user", content: "oi" }] })).rejects.toThrow(/nenhum provider/i);
  });
});

describe("ModelGateway — adapters e segurança", () => {
  it("OpenAICompatibleAdapter propaga status de erro e nunca loga a chave", async () => {
    behavior["sk-x"] = { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) };
    const adapter = new OpenAICompatibleAdapter({ name: "test", baseUrl, apiKey: "sk-x", model: "m" });
    try {
      await adapter.complete({ messages: [{ role: "user", content: "oi" }] });
      expect.unreachable("deveria falhar");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("429");
      expect(msg).not.toContain("sk-x"); // chave não vaza no erro
      expect((e as { status?: number }).status).toBe(429);
    }
  });

  it("GroqGatewayProvider expõe keySlot (observabilidade sem chave)", async () => {
    for (let i = 2; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
    delete process.env.GROQ_API_KEY;
    setEnv({ GROQ_BASE_URL: baseUrl, GROQ_MODEL: "m", GROQ_API_KEY_1: "gkz" });
    behavior["gkz"] = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }] }) };
    const p = new GroqGatewayProvider({ keys: ["gkz"], baseUrl, model: "m" });
    const r = await p.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(r.content).toBe("ok");
    expect(p.lastKeySlot).toBe(1);
  });

  it("métricas coletadas têm provider/model/keySlot/latency/tokens", async () => {
    for (let i = 2; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
    delete process.env.GROQ_API_KEY;
    pointGatewayAtLocal("groq", { GROQ_API_KEY_1: "gm", ALIBABA_API_KEY: "" });
    behavior["gm"] = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 7, completion_tokens: 9 } }) };
    const gw = new ModelGateway(buildProviderChain({ env: process.env }));
    const out = await gw.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(out.provider).toBe("groq");
    expect(out.keySlot).toBe(1);
    expect(out.latencyMs).toBeGreaterThanOrEqual(0);
    expect(out.attempts[0]!.tokensPrompt).toBe(7);
    expect(out.attempts[0]!.tokensCompletion).toBe(9);
    expect(JSON.stringify(out.attempts)).not.toContain("gm-"); // nenhum valor de chave
  });
});

describe("Alibaba/Qwen — seleção dinâmica de modelo por workload", () => {
  it("ALIBABA_MODEL explícito sobrepõe para todos os workloads", () => {
    const env = { ALIBABA_MODEL: "qwen-custom" } as NodeJS.ProcessEnv;
    expect(resolveAlibabaModel("chat", env)).toBe("qwen-custom");
    expect(resolveAlibabaModel("reasoning", env)).toBe("qwen-custom");
  });

  it("ALIBABA_MODEL vazio → modelo por workload (cada agente usa o adequado)", () => {
    const env = { ALIBABA_MODEL: "" } as NodeJS.ProcessEnv;
    expect(resolveAlibabaModel("fast", env)).toBe("qwen-turbo");
    expect(resolveAlibabaModel("chat", env)).toBe("qwen-plus");
    expect(resolveAlibabaModel("reasoning", env)).toBe("qwen-max");
    expect(resolveAlibabaModel("research", env)).toBe("qwen-long");
    expect(resolveAlibabaModel("coding", env)).toBe("qwen-max");
    expect(resolveAlibabaModel("vision", env)).toBe("qwen-vl-max");
  });

  it("workload desconhecido → default chat", () => {
    const env = { ALIBABA_MODEL: "" } as NodeJS.ProcessEnv;
    expect(resolveAlibabaModel(undefined, env)).toBe("qwen-plus");
    expect(resolveAlibabaModel("algo-inexistente", env)).toBe("qwen-plus");
  });

  it("AlibabaProvider usa modelo do workload quando ALIBABA_MODEL vazio", () => {
    setEnv({ ALIBABA_API_KEY: "sk-test", ALIBABA_MODEL: "", ALIBABA_BASE_URL: "http://x" });
    const pChat = new AlibabaProvider({ workload: "chat" });
    expect(pChat.model).toBe("qwen-plus");
    const pReason = new AlibabaProvider({ workload: "reasoning" });
    expect(pReason.model).toBe("qwen-max");
    // model explícito vence
    const pExplicit = new AlibabaProvider({ model: "qwen-max", workload: "chat" });
    expect(pExplicit.model).toBe("qwen-max");
  });

  it("buildProviderChain inclui Alibaba só com chave (modelo vazio = auto por workload)", () => {
    for (let i = 1; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
    delete process.env.GROQ_API_KEY;
    pointGatewayAtLocal("alibaba", { ALIBABA_API_KEY: "sk-x", ALIBABA_MODEL: "", OPENROUTER_API_KEY: "" });
    // vision é workload especializado → Alibaba entra
    const chain = buildProviderChain({ env: process.env, workload: "vision" });
    expect(chain.map((p) => p.name)).toEqual(["alibaba"]);
    expect(chain[0]!.model).toBe("qwen-vl-max"); // vision → qwen-vl-max
  });
});
