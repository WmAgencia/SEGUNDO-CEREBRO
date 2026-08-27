import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import { SingleAgent, ChatMessage } from "../core/agent/single-agent.ts";
import { listSessions, ensureSession, getMessages, persistMessage } from "../core/agent/session-store.ts";
import { createDefaultRegistry } from "../core/agent/tools/index.ts";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* retry on Windows */ }
  }
});

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "sb-single-"));
  dirs.push(dir);
  const vaultPath = path.join(dir, "vault");
  mkdirSync(vaultPath, { recursive: true });
  const config = {
    vaultPath,
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error" as LogLevel,
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1", model: "test" },
  };
  const db = openDatabase(config.dbPath);
  applySchema(db);
  db.close();
  return { dir, config };
}

function fakeLLM(text: string) {
  return async (messages: ChatMessage[]): Promise<{ content: string }> => ({ content: text });
}

describe("core/agent/single-agent", () => {
  it("responde conversacionalmente e persiste a mensagem", async () => {
    const { config } = setup();
    const agent = new SingleAgent({ llm: fakeLLM("Oi! Estou aqui. O que você quer fazer?") });
    const result = await agent.chat(config, "s-1", "Ei");
    expect(result.type).toBe("answer");
    expect(result.message?.content).toBe("Oi! Estou aqui. O que você quer fazer?");

    const messages = getMessages(config, "s-1", 10);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0]?.content).toBe("Ei");
    expect(messages[1]?.role).toBe("assistant");
  });

  it("sessão existente é restaurada pelo session-store", () => {
    const { config } = setup();
    persistMessage(config, "s-old", "user", "qual o status do projeto?");
    ensureSession(config, "s-old");
    const sessions = listSessions(config);
    expect(sessions.some((s) => s.sessionKey === "s-old")).toBe(true);
    const msgs = getMessages(config, "s-old", 20);
    expect(msgs[0]?.content).toBe("qual o status do projeto?");
  });

  it("conversa multi-turno mantém histórico via LLM real fake", async () => {
    const { config } = setup();
    const historySeen: string[][] = [];
    const llm = async (messages: ChatMessage[]) => {
      historySeen.push(messages.map((m) => `${m.role}:${m.content}`));
      return { content: "continue" };
    };
    const agent = new SingleAgent({ llm });
    await agent.chat(config, "mt", "Primeira mensagem sobre prospecção");
    await agent.chat(config, "mt", "Segunda mensagem sobre clínicas");
    // no segundo turno o modelo recebe o histórico com as duas mensagens do usuário
    const last = historySeen.at(-1) ?? [];
    expect(last.some((m) => m.includes("Primeira mensagem"))).toBe(true);
    expect(last.some((m) => m.includes("Segunda mensagem"))).toBe(true);
  });

  it("usa ferramenta real quando o LLM pede e devolve o resultado (sem approval)", async () => {
    const { config } = setup();
    const agent = new SingleAgent({ llm: fakeLLM(JSON.stringify({ tool: "goal_list", input: {} })) });
    const result = await agent.chat(config, "s-tool", "quais os objetivos ativos?");
    expect(result.type).toBe("answer");
    expect(result.toolResults?.some((t) => t.toolId === "goal_list" && t.success)).toBe(true);
  });

  it("approval gate bloqueia ferramenta que exige aprovação no fluxo do agente", async () => {
    const { config } = setup();
    const agent = new SingleAgent({ llm: fakeLLM(JSON.stringify({ tool: "memory_write", input: { content: "decisão: focar clínicas" } })) });
    const result = await agent.chat(config, "s-approve", "decidi focar em clínicas", undefined);
    expect(result.type).toBe("approval_requested");
    expect(result.approval?.toolId).toBe("memory_write");
  });

  it("com aprovação concedida, executa a ferramenta e completa", async () => {
    const { config } = setup();
    const agent = new SingleAgent({ llm: fakeLLM(JSON.stringify({ tool: "memory_write", input: { content: "aprovado: registrar preferência" } })) });
    const result = await agent.chat(config, "s-ok", "guarda isso", async () => true);
    expect(result.type).toBe("answer");
    expect(result.toolResults?.at(-1)?.success).toBe(true);
  });

  it("resumeApproval executa a ferramenta aprovada na próxima chamada", async () => {
    const { config } = setup();
    const llm = fakeLLM("Pode registrar. Concluído.");
    const agent = new SingleAgent({ llm });
    const resume = { toolId: "memory_write", input: { content: "resumida após aprovação" } };
    const result = await agent.chat(config, "s-res", "(execução aprovada)", undefined, { resumeApproval: resume });
    expect(result.type).toBe("answer");
    expect(result.toolResults?.at(-1)?.success).toBe(true);
  });

  it("LLM indisponível → erro claro, não resposta falsa", async () => {
    const { config } = setup();
    const agent = new SingleAgent({
      llm: async () => { throw new Error("GROQ_API_KEY not configured"); },
    });
    const result = await agent.chat(config, "s-err", "Oi");
    expect(result.type).toBe("error");
    expect(result.message?.content).toMatch(/GROQ_API_KEY/i);
  });

  it("reachable registry expõe ferramentas reais (sem mocks)", () => {
    const r = createDefaultRegistry();
    expect(r.available().length).toBeGreaterThanOrEqual(12);
    expect(r.available().every((t) => t.available)).toBe(true);
  });
});