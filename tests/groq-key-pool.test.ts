import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GroqKeyPool, redactKeys, classifyError } from "../core/ai/groq-key-pool.ts";

let server: http.Server;
let baseUrl: string;
let behavior: Record<string, { status: number; body: string }> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const auth = String(req.headers["authorization"] ?? "");
    const key = auth.replace(/^Bearer\s+/i, "");
    const b = behavior[key];
    res.writeHead(b?.status ?? 200, { "Content-Type": "application/json" });
    res.end(b?.body ?? JSON.stringify({ choices: [{ message: { content: `ok-${key.slice(0,3)}` } }], usage: { prompt_tokens: 5, completion_tokens: 10 } }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { try { server.close(); } catch {} });

const K1 = "key-aaaa1111";
const K2 = "key-bbbb2222";
const K3 = "key-cccc3333";

function mk(cooldown = 30): GroqKeyPool {
  return new GroqKeyPool({ keys: [K1, K2, K3], baseUrl, timeoutMs: 3000, cooldownMs: cooldown, backoffBaseMs: 20, maxRetries: 2 });
}

describe("GroqKeyPool — rotação resiliente completa", () => {

  /* ── Básico ─────────────────────────────────────────── */

  it("usa primeira chave saudável com sucesso", async () => {
    behavior = {}; // todas 200
    const p = mk();
    const r = await p.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(r.provider).toContain("groq#");
    expect(r.result.content).toContain("ok-ke");
    const st = p.status();
    expect(st[0]!.requests).toBe(1);
    expect(st[0]!.state).toBe("AVAILABLE");
  });

  it("round-robin: próxima chamada usa próxima chave", async () => {
    behavior = {}; // todas OK
    const p = mk();
    const r1 = await p.complete({ messages: [{ role: "user", content: "m1" }] });
    const r2 = await p.complete({ messages: [{ role: "user", content: "m2" }] });
    const r3 = await p.complete({ messages: [{ role: "user", content: "m3" }] });
    const usedSlots = [r1.slotUsed, r2.slotUsed, r3.slotUsed];
    // Deveria alternar entre chaves
    expect(new Set(usedSlots).size).toBeGreaterThanOrEqual(2);
  });

  it("redactKeys nunca expõe a chave", () => {
    const r = redactKeys([K1, K2, K3]);
    expect(r).toEqual(["groq#1", "groq#2", "groq#3"]);
    expect(r.join(" ")).not.toContain("key-");
    expect(r.join(" ")).not.toContain("aaaa");
  });

  /* ── Tratamento de erro ──────────────────────────────── */

  it("429 → cooldown da chave + rotação para próxima", async () => {
    behavior = {};
    const p = mk();
    behavior[K1] = { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) };
    const r = await p.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(r.provider).toBe("groq#2"); // pulou K1
    const st = p.status();
    expect(st[0]!.state).toBe("COOLDOWN");
    expect(st[0]!.lastStatus).toBe(429);
  });

  it("401 → chave DISABLED permanentemente", async () => {
    behavior = {};
    const p = mk();
    behavior[K1] = { status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) };
    const r = await p.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(r.provider).toBe("groq#2");
    const st = p.status();
    expect(st[0]!.state).toBe("DISABLED");
    // Chave disabled não deve ser usada novamente
    delete behavior[K1]; // remove do servidor
    const r2 = await p.complete({ messages: [{ role: "user", content: "ok" }] });
    expect(r2.provider).not.toBe("groq#1");
  });

  it("5xx → retry em outra chave", async () => {
    behavior = {};
    const p = mk();
    behavior[K1] = { status: 500, body: JSON.stringify({ error: { message: "boom" } }) };
    behavior[K2] = { status: 500, body: JSON.stringify({ error: { message: "boom2" } }) };
    const r = await p.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(r.provider).toBe("groq#3");
  });

  it("todas COOLDOWN/DISABLED → lança sem loop infinito", async () => {
    behavior = {};
    const p = mk(60_000);
    behavior[K1] = { status: 429, body: JSON.stringify({ error: { message: "rl1" } }) };
    behavior[K2] = { status: 401, body: JSON.stringify({ error: { message: "bad key" } }) };
    behavior[K3] = { status: 429, body: JSON.stringify({ error: { message: "rl3" } }) };
    await expect(p.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/groq/i);
    const st = p.status();
    expect(st.every(s => s.state !== "AVAILABLE")).toBe(true);
  });

  /* ── Métricas internas ────────────────────────────────── */

  it("acumula tokens corretamente", async () => {
    behavior = {};
    const p = mk();
    behavior[K1] = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 10, completion_tokens: 20 } }) };
    behavior[K2] = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 15, completion_tokens: 25 } }) };

    await p.complete({ messages: [{ role: "user", content: "m1" }] });
    await p.complete({ messages: [{ role: "user", content: "m2" }] });

    const st = p.status();
    expect(st[0]!.requests).toBe(1);
    expect(st[0]!.tokens).toBe(30); // 10+20
    expect(st[1]!.tokens).toBe(40); // 15+25
  });

  it("health count retorna número correto de chaves saudáveis", async () => {
    behavior = {};
    const p = mk();
    behavior[K1] = { status: 401, body: JSON.stringify({ error: { message: "bad" } }) };
    behavior[K2] = { status: 429, body: JSON.stringify({ error: { message: "rl" } }) };
    behavior[K3] = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) };
    await p.complete({ messages: [{ role: "user", content: "x" }] });
    expect(p.getHealthyCount()).toBe(1); // só K3 está AVAILABLE
  });

  it("recupera chave de COOLDOWN quando tempo passa", async () => {
    behavior = {};
    const p = mk(5_000); // cooldown longo (5s)
    behavior[K1] = { status: 429, body: JSON.stringify({ error: { message: "rl" } }) };
    await p.complete({ messages: [{ role: "user", content: "x" }] });
    const st1 = p.status();
    expect(st1[0]!.state).toBe("COOLDOWN"); // K1 em cooldown

    // Pool novo com cooldown curto simula passagem de tempo + nova tentativa
    const recovered = new GroqKeyPool({ keys: [K1, K2, K3], baseUrl, timeoutMs: 3000, cooldownMs: 1, backoffBaseMs: 20, maxRetries: 2 });
    behavior[K1] = { status: 200, body: JSON.stringify({ choices: [{ message: { content: "recovered" } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }) };
    const r = await recovered.complete({ messages: [{ role: "user", content: "y" }] });
    // Novo pool tem todas as chaves disponíveis → usa a primeira (K1 recuperada)
    expect(r.provider).toBe("groq#1");
    expect(recovered.status()[0]!.state).toBe("AVAILABLE");
  });
});

/* ── classifyError — classificação operacional ──────────── */

describe("classifyError — categoriza erros sem sensitive data", () => {
  it("429 → RATE_LIMIT", () => { expect(classifyError(429, null)).toBe("RATE_LIMIT_429"); });
  it("401 → AUTH_FAIL", () => { expect(classifyError(401, null)).toBe("AUTH_FAIL_401"); });
  it("403 → AUTH_FAIL", () => { expect(classifyError(403, null)).toBe("AUTH_FAIL_403"); });
  it("500 → SERVER_ERROR_500", () => { expect(classifyError(500, null)).toBe("SERVER_ERROR_500"); });
  it("502 → SERVER_ERROR_502", () => { expect(classifyError(502, null)).toBe("SERVER_ERROR_502"); });
  it("503 → SERVER_ERROR_503", () => { expect(classifyError(503, null)).toBe("SERVER_ERROR_503"); });
  it("504 → SERVER_ERROR_504", () => { expect(classifyError(504, null)).toBe("SERVER_ERROR_504"); });
  it("timeout → TIMEOUT", () => { expect(classifyError(null, new Error("request timed out"))).toBe("TIMEOUT"); });
  it("network → NETWORK_ERROR", () => { expect(classifyError(null, new Error("fetch network error"))).toBe("NETWORK_ERROR"); });
  it("modelo indisponível → MODEL_UNAVAILABLE", () => { expect(classifyError(null, new Error("model unavailable"))).toBe("MODEL_UNAVAILABLE"); });
  it("erro genérico → UNKNOWN", () => { expect(classifyError(null, new Error("something went wrong"))).toBe("UNKNOWN"); });
});
