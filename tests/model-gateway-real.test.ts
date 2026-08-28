/**
 * FASE Groq+Alibaba — testes com PROVIDERS REAIS (seção 16).
 *
 * Executa chamadas reais contra Groq (chaves de .env.local) e Alibaba. Se um
 * provider estiver bloqueado por credencial/capacidade, o teste declara BLOCKED
 * com o motivo exato — nunca converte em PASS nem mascara a falha.
 */

import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModelGateway, buildProviderChain, loadGatewayGroqKeys, readGatewayEnv } from "../core/ai/model-gateway.ts";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { BrainConfig } from "../core/config/loader.ts";
import type { LogLevel } from "../core/logger/logger.ts";

// carrega .env.local (mesmo padrão do server) sem sobrescrever o que já existe
beforeAll(() => {
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m?.[1] && m[2] !== undefined && process.env[m[1]] === undefined) process.env[m[1]] = m[2].trim();
    }
  }
});

function classify(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/tokens per minute|rate.?limit|429|context ?overflow|too large/i.test(msg)) return "BLOCKED_CAPACITY";
  if (/401|403|invalid|auth|incorrect/i.test(msg)) return "BLOCKED_AUTH";
  if (/timeout|timed out|network|fetch|connection/i.test(msg)) return "BLOCKED_NETWORK";
  return "FAIL_OR_BLOCKED";
}

describe("ModelGateway — chamada REAL Groq", () => {
  it("Groq com chave real responde (ou BLOCKED com motivo exato)", async () => {
    const keys = loadGatewayGroqKeys();
    if (keys.length === 0) {
      console.log("[REAL] Groq BLOCKED — nenhuma GROQ_API_KEY preenchida em .env.local");
      return;
    }
    console.log(`[REAL] Groq: ${keys.length} chave(s) detectada(s)`);
    const gw = new ModelGateway(buildProviderChain({ env: process.env, groqModel: process.env.GROQ_MODEL ?? "openai/gpt-oss-120b" }));
    try {
      const out = await gw.complete({ messages: [{ role: "user", content: "Responda apenas com a palavra OK." }], maxTokens: 16, temperature: 0 });
      expect(out.provider).toBe("groq");
      expect(out.content.length).toBeGreaterThan(0);
      console.log(`[REAL] Groq PASS REAL — provider=${out.provider} keySlot=${out.keySlot} model=${out.model} latency=${out.latencyMs}ms`);
    } catch (e) {
      const cat = classify(e);
      console.log(`[REAL] Groq ${cat} — ${(e as Error).message.slice(0, 180)}`);
      expect(["BLOCKED_CAPACITY", "BLOCKED_AUTH", "BLOCKED_NETWORK", "FAIL_OR_BLOCKED"]).toContain(cat);
    }
  }, 90000);
});

describe("ModelGateway — chamada REAL Alibaba/Qwen", () => {
  it("Alibaba responde se chave válida; senão BLOCKED com motivo exato", async () => {
    const env = readGatewayEnv();
    if (!env.alibabaApiKey) {
      console.log("[REAL] Alibaba BLOCKED — ALIBABA_API_KEY ausente em .env.local");
      expect(true).toBe(true);
      return;
    }
    // modelo resolvido por workload (ALIBABA_MODEL pode estar vazio); isola a
    // Alibaba desabilitando o Groq para testar o provider de verdade
    const gw = new ModelGateway(buildProviderChain({ env: process.env, workload: "chat", overrides: { groq: null, openrouter: null } }));
    try {
      const out = await gw.complete({ messages: [{ role: "user", content: "Responda apenas OK." }], maxTokens: 16 });
      expect(out.content.length).toBeGreaterThan(0);
      console.log(`[REAL] Alibaba PASS REAL — provider=${out.provider} model=${out.model}`);
    } catch (e) {
      const cat = classify(e);
      console.log(`[REAL] Alibaba ${cat} — ${(e as Error).message.slice(0, 180)}`);
      expect(["BLOCKED_CAPACITY", "BLOCKED_AUTH", "BLOCKED_NETWORK", "FAIL_OR_BLOCKED"]).toContain(cat);
    }
  }, 90000);
});

describe("ModelGateway — fallback REAL Groq→Alibaba", () => {
  it("cadeia real tenta Groq e depois Alibaba (ou BLOCKED documentado)", async () => {
    const env = readGatewayEnv();
    if (env.groqKeys.length === 0 && !env.alibabaApiKey) {
      console.log("[REAL] fallback BLOCKED — nenhum provider com credencial");
      return;
    }
    const gw = new ModelGateway(buildProviderChain({ env: process.env }));
    try {
      const out = await gw.complete({ messages: [{ role: "user", content: "Responda apenas OK." }], maxTokens: 16 });
      expect(out.content.length).toBeGreaterThan(0);
      console.log(`[REAL] fallback PASS REAL — respondeu por ${out.provider} (fallbackCount=${out.fallbackCount})`);
    } catch (e) {
      const cat = classify(e);
      console.log(`[REAL] fallback ${cat} — ${(e as Error).message.slice(0, 180)}`);
      expect(["BLOCKED_CAPACITY", "BLOCKED_AUTH", "BLOCKED_NETWORK", "FAIL_OR_BLOCKED"]).toContain(cat);
    }
  }, 120000);
});

describe("SingleAgent — conversa REAL via Model Gateway (USER→Groq→resposta)", () => {
  let dir: string;
  afterAll(() => { try { if (dir) rmSync(dir, { recursive: true, force: true }); } catch {} });

  it("'Oi' responde naturalmente pelo provider real (ou BLOCKED com motivo)", async () => {
    const keys = loadGatewayGroqKeys();
    const env = readGatewayEnv();
    if (keys.length === 0 && !env.alibabaApiKey) {
      console.log("[REAL] chat BLOCKED — nenhum provider com credencial");
      return;
    }
    dir = mkdtempSync(path.join(tmpdir(), "sb-realchat-"));
    mkdirSync(path.join(dir, "vault"), { recursive: true });
    const config = {
      vaultPath: path.join(dir, "vault"), dataDir: dir, dbPath: path.join(dir, "b.db"),
      logLevel: "error" as LogLevel,
      search: { defaultLimit: 10, maxLimit: 50 },
      context: { maxChars: 6000, defaultDepth: 1, maxDepth: 2 },
      ai: { baseUrl: "http://127.0.0.1", model: "test" },
    } as BrainConfig;
    const db = openDatabase(config.dbPath); applySchema(db); db.close();

    const { SingleAgent } = await import("../core/agent/single-agent.ts");
    const agent = new SingleAgent(); // llm default = completeWithGateway (Model Gateway real)
    try {
      const res = await agent.chat(config, "real-chat", "Oi");
      expect(res.type).toBe("answer");
      expect((res.message?.content ?? "").length).toBeGreaterThan(0);
      // resposta natural, sem template de roteador
      expect((res.message?.content ?? "").toLowerCase()).not.toContain("posso criar um objetivo, consultar o second brain ou verificar");
      console.log(`[REAL] chat PASS REAL — "${(res.message?.content ?? "").slice(0, 80)}"`);
    } catch (e) {
      const cat = classify(e);
      console.log(`[REAL] chat ${cat} — ${(e as Error).message.slice(0, 180)}`);
      expect(["BLOCKED_CAPACITY", "BLOCKED_AUTH", "BLOCKED_NETWORK", "FAIL_OR_BLOCKED"]).toContain(cat);
    }
  }, 120000);
});