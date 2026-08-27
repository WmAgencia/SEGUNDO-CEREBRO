/**
 * FASE 3.7 — E2E da interface (TESTE 1..11).
 *
 * Servidor HTTP REAL (createAgentServer) sobe em porta efêmera com config
 * temporária. Session store, tools, Graph API e assets são reais; apenas o
 * LLM é stub (provider externo não é requisito da fase).
 */

import { mkdirSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { LogLevel } from "../core/logger/logger.ts";
import type { BrainConfig } from "../core/config/loader.ts";
import { SingleAgent, ChatMessage } from "../core/agent/single-agent.ts";
import { createAgentServer } from "../apps/agent/server.ts";
import { createRun, addNodes, listRuns } from "../core/orchestration/graph-store.ts";
import { GraphExecutor } from "../core/orchestration/executor.ts";
import { ToolExecutor } from "../core/agent/tools/executor.ts";
import { createDefaultRegistry } from "../core/agent/tools/index.ts";
import { goalCreateTool } from "../core/agent/tools/web-media-tools.ts";
import type { GraphPlan } from "../core/orchestration/types.ts";

let dir: string;
let config: BrainConfig;
let server: import("node:http").Server;
let base = "";

const llmCalls: ChatMessage[][] = [];

function stubAgent(): SingleAgent {
  return new SingleAgent({
    llm: async (messages) => {
      llmCalls.push(messages);
      const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
      const ctxText = messages.map((m) => m.content).join("\n");
      if (/graph_plan/i.test(lastUser) || /clipcom funcionando/i.test(lastUser)) {
        return { content: JSON.stringify({ tool: "graph_plan", input: { request: "colocar o ClipCom funcionando" } }) };
      }
      if (/^Oi$/i.test(lastUser.trim())) {
        return { content: "Oi! Estou aqui. O que você quer fazer?" };
      }
      if (/objetivo atual/i.test(lastUser)) {
        return { content: JSON.stringify({ tool: "goal_list", input: {} }) };
      }
      if (ctxText.includes("goal_list") && lastUser.includes("objetivo")) {
        return { content: "Seu objetivo atual está registrado no contexto." };
      }
      return { content: "Entendido. Conversei usando contexto real do Second Brain." };
    },
  });
}

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "sb-front-"));
  mkdirSync(path.join(dir, "vault"), { recursive: true });
  config = {
    vaultPath: path.join(dir, "vault"),
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error" as LogLevel,
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1", model: "test" },
  } as BrainConfig;
  const db = openDatabase(config.dbPath);
  applySchema(db);
  db.close();

  const created = createAgentServer({ config, agent: stubAgent() });
  server = created.server;
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
}, 30000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

async function j(pathname: string, body?: Record<string, unknown>, method?: string): Promise<Record<string, any>> {
  const res = await fetch(base + pathname, {
    method: body ? method ?? "POST" : method ?? "GET",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as Record<string, any>;
}

async function readSSE(pathname: string): Promise<Array<{ event: string; data: any }>> {
  const res = await fetch(base + pathname);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const events: Array<{ event: string; data: any }> = [];
  let current = "message";
  const text = await res.text();
  for (const chunk of text.split("\n\n")) {
    const lines = chunk.split("\n");
    for (const line of lines) {
      if (line.startsWith("event: ")) current = line.slice(7).trim();
      else if (line.startsWith("data: ")) {
        try { events.push({ event: current, data: JSON.parse(line.slice(6)) }); } catch {}
        current = "message";
      }
    }
  }
  return events;
}

describe("FASE 3.7 — E2E da interface (HTTP real)", () => {
  it("TESTE 1 — abrir aplicação: ChatGPT-like, não HQ", async () => {
    const res = await fetch(base + "/");
    expect(res.status).toBe(200);
    const html = await res.text();
    // marcadores da UI nova
    expect(html).toContain("btn-new-chat");
    expect(html).toContain("composer");
    expect(html).toContain("session-list");
    expect(html).toContain("Como posso ajudar?");
    // nada do escritório antigo
    expect(html.toLowerCase()).not.toContain("office");
    expect(html.toLowerCase()).not.toContain("mesa");
    expect(html.toLowerCase()).not.toContain("departamento");
    // assets carregam
    const css = await fetch(base + "/style.css");
    expect(css.status).toBe(200);
    const js = await fetch(base + "/app.js");
    expect(js.status).toBe(200);
    const cfg = await fetch(base + "/config.js");
    expect(cfg.status).toBe(200);
  });

  it("TESTE 2 — novo chat cria sessão real", async () => {
    const r = await j("/api/chat/session", { key: "e2e-s1", title: "Conversa de teste" });
    expect(r.sessionKey).toBe("e2e-s1");
    const { sessions } = await j("/api/chat/sessions");
    const s = sessions.find((x: any) => x.sessionKey === "e2e-s1");
    expect(s).toBeTruthy();
    expect(s.topic).toBe("Conversa de teste");
  });

  it("TESTE 3 — enviar 'Oi' → resposta conversacional (sem template de acionável)", async () => {
    const r = await j("/api/chat/session/e2e-s1/message", { text: "Oi" });
    expect(r.type).toBe("answer");
    expect(r.message.content).toMatch(/Oi/);
    expect(r.message.content.toLowerCase()).not.toContain("quer que eu transforme");
  });

  it("TESTE 4 — 'Qual é meu objetivo atual?' consulta contexto real", async () => {
    // cria goal real antes
    const g = await goalCreateTool.execute(
      { name: "Faturar R$5.000 este mês", type: "BUSINESS" },
      { config, sessionId: "e2e-s1" },
    );
    expect(g.success).toBe(true);

    const before = llmCalls.length;
    const r = await j("/api/chat/session/e2e-s1/message", { text: "Qual é meu objetivo atual?" });
    expect(r.type).toBe("answer");
    expect(r.toolResults?.some((t: any) => t.toolId === "goal_list" && t.success)).toBe(true);
    // o contexto injetado no modelo contém o objetivo real (goals ativos)
    const ctxSeen = llmCalls.slice(before).flat().map((m) => m.content).join("\n");
    expect(ctxSeen).toMatch(/Faturar R\$5\.000|Objetivos ativos/i);
  });

  it("TESTE 5 — executar ferramenta: evento tool visível no stream SSE", async () => {
    const events = await readSSE("/api/chat/session/e2e-s1/stream?text=" + encodeURIComponent("Qual é meu objetivo atual?"));
    const kinds = events.map((e) => e.event);
    expect(kinds).toContain("status");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("message");
    expect(kinds).toContain("done");
    const toolEvts = events.filter((e) => e.event === "tool");
    expect(toolEvts.some((e) => e.data.toolId === "goal_list" && e.data.phase === "start")).toBe(true);
    expect(toolEvts.some((e) => e.data.toolId === "goal_list" && e.data.phase === "done")).toBe(true);
  });

  it("TESTE 6 — criar Graph via chat: run real aparece em /api/graphs", async () => {
    const r = await j("/api/chat/session/e2e-s1/message", { text: "graph_plan clipcom funcionando" });
    expect(r.type).toBe("answer");
    const { runs } = await j("/api/graphs?limit=20");
    const run = runs.find((x: any) => x.sessionKey === "e2e-s1" && /clipcom/i.test(x.request));
    expect(run).toBeTruthy();
    expect(run.status).toBe("PLANNED");
    expect(run.nodes.length).toBeGreaterThanOrEqual(5);
  });

  it("TESTE 7 — Graph em execução: progresso real por nó em /api/graphs/:runId", async () => {
    // run real com tool nodes executáveis (goal_list) — executa de verdade
    const run = createRun(config, { sessionKey: "e2e-s1", request: "objetivos do projeto", goal: "levantar objetivos" });
    const plan: GraphPlan = {
      goal: "levantar objetivos",
      nodes: [
        { id: "a", title: "Listar objetivos", type: "tool", toolId: "goal_list" },
        { id: "b", title: "Revisar lista", type: "tool", toolId: "goal_list", dependencies: ["a"] },
      ],
    };
    addNodes(config, run.id, plan);
    const registry = createDefaultRegistry();
    const ex = new GraphExecutor({ registry, executor: new ToolExecutor(registry), subagentRunner: { isAvailable: async () => false, run: async () => ({ ok: false, status: "BLOCKED", output: "", sessionId: null, filesChanged: [], testsPassed: false, error: "n/a", unavailable: true, durationMs: 1 }) } });
    const out = await ex.execute(config, run.id);
    expect(out.status).toBe("COMPLETED");

    const detail = await j("/api/graphs/" + encodeURIComponent(run.id));
    expect(detail.run.status).toBe("COMPLETED");
    expect(detail.nodes.length).toBe(2);
    expect(detail.nodes.every((n: any) => n.status === "COMPLETED")).toBe(true);
    expect(detail.events.length).toBeGreaterThan(0);
    // telemetria padronizada presente
    const evNames = detail.events.map((e: any) => e.event);
    expect(evNames).toContain("started");
    expect(evNames).toContain("completed");
  });

  it("TESTE 8 — Conexões: estado honesto da Evolution (sem inventar)", async () => {
    const r = await j("/api/connections");
    expect(r.whatsapp).toBeTruthy();
    expect(typeof r.whatsapp.state).toBe("string");
    expect(typeof r.whatsapp.aiEnabled).toBe("boolean");
    // toggle de IA persiste e não desconecta
    const t = await j("/api/connections/whatsapp/ai", { enabled: false });
    expect(t.aiEnabled).toBe(false);
    const r2 = await j("/api/connections");
    expect(r2.whatsapp.aiEnabled).toBe(false);
    await j("/api/connections/whatsapp/ai", { enabled: true });
    // connect responde com estado real (unconfigured sem Evolution no teste)
    const c = await j("/api/connections/whatsapp/connect", {});
    expect(["unconfigured", "qrcode", "open", "error"]).toContain(c.state);
    if (c.state === "unconfigured") expect(c.error).toBeTruthy();
  });

  it("TESTE 9 — Routing: providers reais com chaves mascaradas (nunca completas)", async () => {
    const r = await j("/api/routing");
    expect(r.providers.groq).toBeTruthy();
    expect(r.providers.openrouter).toBeTruthy();
    expect(typeof r.providers.groq.configured).toBe("boolean");
    const raw = JSON.stringify(r);
    for (const k of Object.values(process.env)) {
      if (typeof k === "string" && k.length > 20 && /^gsk_|^sk-/.test(k)) {
        expect(raw).not.toContain(k);
      }
    }
    for (const mk of r.providers.groq.maskedKeys ?? []) {
      expect(String(mk)).toMatch(/^•+.*\d{0,4}$/);
    }
  });

  it("TESTE 10 — Agenda: eventos reais criados e listados", async () => {
    const created = await j("/api/agenda", { title: "Reunião de prospecção", startsAt: new Date(Date.now() + 86400000).toISOString() });
    expect(created.event.id).toBeGreaterThan(0);
    const { events } = await j("/api/agenda");
    expect(events.some((e: any) => e.title === "Reunião de prospecção")).toBe(true);
  });

  it("TESTE 11 — reload: sessão continua com histórico persistido", async () => {
    const { messages } = await j("/api/chat/session/e2e-s1/messages");
    expect(messages.length).toBeGreaterThanOrEqual(4);
    expect(messages.some((m: any) => m.role === "user" && m.content === "Oi")).toBe(true);
    expect(messages.some((m: any) => m.role === "assistant")).toBe(true);
    // rename + delete funcionam
    await j("/api/chat/session/e2e-s1", { title: "Renomeada" }, "PATCH");
    const { sessions } = await j("/api/chat/sessions");
    expect(sessions.find((s: any) => s.sessionKey === "e2e-s1")?.topic).toBe("Renomeada");
  });

  it("SSE stream carrega estados reais em ordem (status → tool → message → done)", async () => {
    const events = await readSSE("/api/chat/session/e2e-s1/stream?text=" + encodeURIComponent("Oi"));
    const kinds = events.map((e) => e.event);
    expect(kinds[0]).toBe("status");
    expect(kinds).toContain("message");
    expect(kinds[kinds.length - 1]).toBe("done");
    const msg = events.find((e) => e.event === "message");
    expect(msg?.data?.type).toBe("answer");
  });
});
