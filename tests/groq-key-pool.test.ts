import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GroqKeyPool, redactKeys } from "../core/ai/groq-key-pool.ts";

let server: http.Server;
let baseUrl: string;
// comportamento por chave (header Authorization) => { status, body }
let behavior: Record<string, { status: number; body: string }> = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const auth = String(req.headers["authorization"] ?? "");
    const key = auth.replace(/^Bearer\s+/i, "");
    const b = behavior[key];
    res.writeHead(b?.status ?? 200, { "Content-Type": "application/json" });
    res.end(b?.body ?? JSON.stringify({ choices: [{ message: { content: `ok-${key.slice(0,2)}` } }], usage: { prompt_tokens: 5, completion_tokens: 10 } }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => { try { server.close(); } catch {} });

const K1 = "key-11111111";
const K2 = "key-22222222";
const K3 = "key-33333333";

function mk(cooldown = 40): GroqKeyPool {
  return new GroqKeyPool({ keys: [K1, K2, K3], baseUrl, timeoutMs: 2000, cooldownMs: cooldown, backoffBaseMs: 20, maxRetries: 2 });
}

describe("GroqKeyPool — rotação resiliente", () => {
  it("usa a primeira chave disponível com sucesso", async () => {
    behavior = {}; // todas 200
    const p = mk();
    const r = await p.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(r.provider).toContain("groq#");
    expect(r.result.content).toContain("ok-ke");
    const st = p.status();
    expect(st[0]!.requests).toBe(1);
    expect(st[0]!.state).toBe("AVAILABLE");
  });

  it("429 → cooldown da chave e rotação para a próxima", async () => {
    behavior = {};
    const p = mk();
    // K1 responde 429
    behavior[K1] = { status: 429, body: JSON.stringify({ error: { message: "rate limited" } }) };
    const r = await p.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(r.provider).toBe("groq#2"); // pulou para K2
    const st = p.status();
    expect(st[0]!.state).toBe("COOLDOWN");       // K1 em cooldown
    expect(st[0]!.lastStatus).toBe(429);
    expect(st[1]!.state).toBe("AVAILABLE");
  });

  it("401 → chave marcada DISABLED (não reutiliza)", async () => {
    behavior = {};
    const p = mk();
    behavior[K1] = { status: 401, body: JSON.stringify({ error: { message: "invalid key" } }) };
    const r = await p.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(r.provider).toBe("groq#2");
    expect(p.status()[0]!.state).toBe("DISABLED");
  });

  it("5xx → retry com backoff em outra chave", async () => {
    behavior = {};
    const p = mk();
    behavior[K1] = { status: 500, body: JSON.stringify({ error: { message: "boom" } }) };
    behavior[K2] = { status: 500, body: JSON.stringify({ error: { message: "boom2" } }) };
    // K3 ok
    const r = await p.complete({ messages: [{ role: "user", content: "oi" }] });
    expect(r.provider).toBe("groq#3");
  });

  it("todas em cooldown → lança erro sem loop infinito", async () => {
    behavior = {};
    const p = mk(60_000); // cooldown longo
    behavior[K1] = { status: 429, body: JSON.stringify({ error: { message: "rl1" } }) };
    behavior[K2] = { status: 429, body: JSON.stringify({ error: { message: "rl2" } }) };
    behavior[K3] = { status: 429, body: JSON.stringify({ error: { message: "rl3" } }) };
    await expect(p.complete({ messages: [{ role: "user", content: "x" }] })).rejects.toThrow(/groq/i);
    // as 3 chaves devem ter ido para COOLDOWN (nenhuma tentou mais de uma vez)
    const st = p.status();
    expect(st.every((s) => s.state === "COOLDOWN")).toBe(true);
    expect(st.every((s) => s.requests === 1)).toBe(true);
  });

  it("redactKeys nunca expõe a chave completa", () => {
    const r = redactKeys([K1, K2, K3]);
    expect(r).toEqual(["groq#1", "groq#2", "groq#3"]);
    expect(r.every((k) => k.includes("#"))).toBe(true);
    expect(r.join(" ")).not.toContain("key-");
  });
});
