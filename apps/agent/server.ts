/**
 * Single Agent HTTP server — serves the ChatGPT-like frontend + the agent API.
 * Static files: apps/agent/public
 * API:
 *   GET  /api/health
 *   GET  /api/chat/sessions
 *   POST /api/chat/session                     { title? }
 *   GET  /api/chat/session/:key/messages
 *   POST /api/chat/session/:key/message        { text }
 *   GET  /api/chat/session/:key/stream?text=   (SSE: eventos reais do turno)
 *   PATCH  /api/chat/session/:key              { title } (renomear)
 *   DELETE /api/chat/session/:key              (excluir)
 *   POST /api/chat/session/:key/approve        { toolId, input, approved }
 *   GET  /api/agenda | POST /api/agenda
 *   GET  /api/connections /api/whatsapp/status
 *   POST /api/connections/whatsapp/connect     (QR real da Evolution)
 *   POST /api/connections/whatsapp/ai          { enabled } (liga/desliga IA, não desconecta)
 *   GET  /api/images
 *   GET  /api/routing                          (providers + chaves mascaradas)
 *   GET  /api/graphs                           (runs + nós)
 *   GET  /api/graphs/:runId                    (detalhe de um run)
 *
 * FASE 3.7: o servidor exporta createAgentServer() para testes E2E reais
 * (HTTP de verdade, session store real, tools reais; apenas o LLM pode ser
 * injetado como stub porque provider externo não é requisito da fase).
 */

import { createServer, IncomingMessage, ServerResponse, Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

// Load .env.local (same pattern as legacy server) — apenas quando rodando standalone
const envPath = path.resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

import { loadConfig } from "../../core/config/loader.ts";
import type { BrainConfig } from "../../core/config/loader.ts";
import { openDatabase, applySchema } from "../../storage/connection.ts";
import { SingleAgent } from "../../core/agent/single-agent.ts";
import type { AgentEvent } from "../../core/agent/single-agent.ts";
import { listSessions, ensureSession, getMessages, renameSession, deleteSession, lastMessagePreview, getSetting, setSetting } from "../../core/agent/session-store.ts";
import { loadGroqKeys } from "../../core/ai/model-router.ts";
import { createToolRequestApproval } from "./approval.ts";
import { listAgendaEvents, createAgendaEvent } from "./agenda-api.ts";

export interface AgentServerOptions {
  config: BrainConfig;
  agent?: SingleAgent;
}

/** Cria o handler HTTP das rotas do Single Agent (API + estático do public).
 *  Separado de createAgentServer para permitir montar as rotas dentro de outro
 *  processo (ex.: apps/hq/server.ts) sem criar um servidor extra. */
export function createAgentHandler(options: AgentServerOptions): { handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>; config: BrainConfig; agent: SingleAgent } {
  const config = options.config;
  const agent = options.agent ?? new SingleAgent();

  // ensure schema
  {
    const db = openDatabase(config.dbPath);
    applySchema(db);
    db.close();
  }

  // recover stale orchestration runs (blocked, never auto-resume risky work)
  {
    import("../../core/orchestration/recovery.ts").then(({ recoverAtStartup }) => {
      const recovered = recoverAtStartup(config);
      if (recovered.length) {
        process.stdout.write(`[recovery] ${recovered.length} run(s) stale recuperado(s) como BLOCKED\n`);
      }
    }).catch(() => {});
  }

  function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
    res.writeHead(status, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS" });
    res.end(contentType.includes("json") ? JSON.stringify(body) : String(body));
  }

  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      let body = "";
      req.on("data", (c) => { body += c.toString(); });
      req.on("end", () => {
        try { resolve(body ? JSON.parse(body) as Record<string, unknown> : {}); } catch { resolve({}); }
      });
    });
  }

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const p = url.pathname;

    // ── Health ──
    if (req.method === "GET" && p === "/api/health") {
      send(res, 200, { status: "ok", model: "single-agent", groqKeys: countGroq(), time: new Date().toISOString() });
      return;
    }

    // ── Sessions ──
    if (req.method === "GET" && p === "/api/chat/sessions") {
      send(res, 200, {
        sessions: listSessions(config).map((s) => ({ ...s, preview: lastMessagePreview(config, s.sessionKey) })),
      });
      return;
    }
    if (req.method === "POST" && p === "/api/chat/session") {
      const body = await readBody(req);
      const key = String(body.key ?? `chat-${Date.now().toString(36)}`);
      ensureSession(config, key);
      if (body.title) renameSession(config, key, String(body.title));
      send(res, 200, { sessionKey: key });
      return;
    }

    const sessionMatch = p.match(/^\/api\/chat\/session\/([^/]+)\/messages$/);
    if (req.method === "GET" && sessionMatch?.[1]) {
      const key = decodeURIComponent(sessionMatch[1]!);
      send(res, 200, { messages: getMessages(config, key, 200) });
      return;
    }

    // rename / delete session
    const sessionOnly = p.match(/^\/api\/chat\/session\/([^/]+)$/);
    if (sessionOnly?.[1] && req.method === "PATCH") {
      const key = decodeURIComponent(sessionOnly[1]!);
      const body = await readBody(req);
      if (body.title) renameSession(config, key, String(body.title));
      send(res, 200, { ok: true });
      return;
    }
    if (sessionOnly?.[1] && req.method === "DELETE") {
      const key = decodeURIComponent(sessionOnly[1]!);
      deleteSession(config, key);
      send(res, 200, { ok: true });
      return;
    }

    // ── SSE streaming (eventos reais do turno) ──
    const streamMatch = p.match(/^\/api\/chat\/session\/([^/]+)\/stream$/);
    if (req.method === "GET" && streamMatch?.[1]) {
      const key = decodeURIComponent(streamMatch[1]!);
      const text = String(url.searchParams.get("text") ?? "").trim();
      if (!text) { send(res, 400, { error: "text required" }); return; }
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "Access-Control-Allow-Origin": "*",
      });
      const push = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      push("status", { stage: "Consultando o Second Brain…" });
      try {
        const onEvent = (evt: AgentEvent) => {
          if (evt.type === "context_compiled") push("status", { stage: "Analisando contexto…" });
          else if (evt.type === "thinking") push("status", { stage: "Consultando o modelo…" });
          else if (evt.type === "tool_start") push("tool", { toolId: evt.toolId, phase: "start", graph: Boolean(evt.graph), stage: evt.graph ? "Executando Graph…" : `Executando ${evt.toolId}…` });
          else if (evt.type === "tool_result") push("tool", { toolId: evt.toolId, phase: "done", success: evt.success, graph: Boolean(evt.graph), output: evt.output ?? null });
          else if (evt.type === "approval_requested") push("approval", { toolId: evt.toolId });
        };
        const result = await agent.chat(config, key, text, createToolRequestApproval(key), { onEvent, deferApproval: true });
        push("message", result);
        push("done", {});
        res.end();
      } catch (error) {
        push("error", { message: error instanceof Error ? error.message : String(error) });
        res.end();
      }
      return;
    }

    const msgMatch = p.match(/^\/api\/chat\/session\/([^/]+)\/message$/);
    if (req.method === "POST" && msgMatch?.[1]) {
      const key = decodeURIComponent(msgMatch[1]!);
      const body = await readBody(req);
      const text = String(body.text ?? "").trim();
      if (!text) { send(res, 400, { error: "text required" }); return; }
      const result = await agent.chat(config, key, text, createToolRequestApproval(key), { deferApproval: true });
      send(res, 200, result);
      return;
    }

    const approveMatch = p.match(/^\/api\/chat\/session\/([^/]+)\/approve$/);
    if (req.method === "POST" && approveMatch?.[1]) {
      const key = decodeURIComponent(approveMatch[1]!);
      const body = await readBody(req);
      const toolId = String(body.toolId ?? "");
      const approved = body.approved !== false;
      const input = (body.input && typeof body.input === "object" ? body.input : {}) as Record<string, unknown>;
      if (!toolId) { send(res, 400, { error: "toolId required" }); return; }
      if (!approved) {
        send(res, 200, { type: "cancelled", message: "Ação cancelada." });
        return;
      }
      const result = await agent.chat(config, key, "(execução aprovada)", undefined, { resumeApproval: { toolId, input } });
      send(res, 200, result);
      return;
    }

    // ── Graphs (painel + cards no chat) ──
    if (req.method === "GET" && p === "/api/graphs") {
      try {
        const { listRuns, listNodes } = await import("../../core/orchestration/graph-store.ts");
        const runs = listRuns(config, undefined, Number(url.searchParams.get("limit") ?? 20));
        const withNodes = runs.map((r) => ({
          id: r.id, goal: r.goal, status: r.status, sessionKey: r.sessionKey, request: r.request,
          updatedAt: r.updatedAt, completedAt: r.completedAt,
          nodes: listNodes(config, r.id).map((n) => ({ id: n.id, title: n.title, status: n.status, error: n.error, retryCount: n.retryCount, type: n.type, assignedAgent: n.assignedAgent })),
        }));
        send(res, 200, { runs: withNodes });
      } catch (error) {
        send(res, 200, { runs: [], error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const graphMatch = p.match(/^\/api\/graphs\/([^/]+)$/);
    const graphNodesMatch = p.match(/^\/api\/graphs\/([^/]+)\/nodes$/);
    const graphEventsMatch = p.match(/^\/api\/graphs\/([^/]+)\/events$/);
    if (req.method === "GET" && (graphMatch?.[1] || graphNodesMatch?.[1] || graphEventsMatch?.[1])) {
      try {
        const { getRun, listNodes, nodeHistory } = await import("../../core/orchestration/graph-store.ts");
        const runId = decodeURIComponent((graphMatch?.[1] ?? graphNodesMatch?.[1] ?? graphEventsMatch?.[1])!);
        const run = getRun(config, runId);
        if (!run) { send(res, 404, { error: "run not found" }); return; }
        const nodes = listNodes(config, runId);
        const mapNode = (n: typeof nodes[number]) => ({
          id: n.id, title: n.title, status: n.status, type: n.type,
          agentId: n.assignedAgent, sessionId: n.sessionId,
          attempt: n.retryCount, parentNodeIds: n.dependencies,
          error: n.error, dependencies: n.dependencies,
          evidence: (n.evidence ?? []).slice(0, 8),
          startedAt: n.startedAt, completedAt: n.completedAt,
          durationMs: n.startedAt && n.completedAt ? Math.max(0, Date.parse(n.completedAt) - Date.parse(n.startedAt)) : null,
          output: n.output ?? null,
        });
        if (graphNodesMatch?.[1]) { send(res, 200, { runId, nodes: nodes.map(mapNode) }); return; }
        if (graphEventsMatch?.[1]) { send(res, 200, { runId, events: nodeHistory(config, runId) }); return; }
        send(res, 200, {
          run: { id: run.id, goal: run.goal, status: run.status, request: run.request, sessionKey: run.sessionKey, createdAt: run.createdAt, updatedAt: run.updatedAt, completedAt: run.completedAt, result: run.result },
          nodes: nodes.map(mapNode),
          events: nodeHistory(config, runId).slice(-40),
        });
      } catch (error) {
        send(res, 500, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    // ── Agenda ──
    if (req.method === "GET" && p === "/api/agenda") {
      send(res, 200, { events: listAgendaEvents(config) });
      return;
    }
    if (req.method === "POST" && p === "/api/agenda") {
      const body = await readBody(req);
      const title = String(body.title ?? "").trim();
      const startsAt = String(body.startsAt ?? "");
      if (!title || !startsAt) { send(res, 400, { error: "title and startsAt required" }); return; }
      send(res, 200, { event: createAgendaEvent(config, title, startsAt, String(body.description ?? "")) });
      return;
    }

    // ── WhatsApp / connections ──
    if (req.method === "GET" && (p === "/api/connections" || p === "/api/whatsapp/status")) {
      try {
        const { getConnectionState, isAvailable } = await import("../../core/comms/evolution-api.ts");
        const state = await getConnectionState();
        send(res, 200, {
          whatsapp: {
            state,
            available: await isAvailable(),
            aiEnabled: getSetting(config, "whatsapp_ai_enabled", "1") === "1",
          },
        });
      } catch (error) {
        send(res, 200, { whatsapp: { state: "unconfigured", available: false, aiEnabled: getSetting(config, "whatsapp_ai_enabled", "1") === "1", error: error instanceof Error ? error.message.slice(0, 120) : String(error) } });
      }
      return;
    }
    if (req.method === "POST" && p === "/api/connections/whatsapp/connect") {
      try {
        const { connectInstance } = await import("../../core/comms/evolution-api.ts");
        const result = await connectInstance();
        send(res, 200, result);
      } catch (error) {
        send(res, 200, { state: "error", qrBase64: null, pairingCode: null, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    if (req.method === "POST" && p === "/api/connections/whatsapp/ai") {
      const body = await readBody(req);
      const enabled = body.enabled !== false;
      setSetting(config, "whatsapp_ai_enabled", enabled ? "1" : "0");
      send(res, 200, { ok: true, aiEnabled: enabled });
      return;
    }

    // ── Images (tool_execution de image_generate com URLs reais) ──
    if (req.method === "GET" && p === "/api/images") {
      const db = openDatabase(config.dbPath);
      try {
        const rows = db.prepare("SELECT id, payload, occurred_at FROM events WHERE event_type='tool_execution' AND subject='image_generate' AND payload LIKE '%\"success\":true%' ORDER BY id DESC LIMIT 30").all() as Array<{ id: number; payload: string; occurred_at: string }>;
        send(res, 200, { images: rows });
      } finally { db.close(); }
      return;
    }

    // ── Routing / providers (chaves mascaradas, nunca completas) ──
    if (req.method === "GET" && p === "/api/routing") {
      const keys = safeGroqKeys();
      const orKey = process.env.OPENROUTER_API_KEY ?? "";
      send(res, 200, {
        providers: {
          groq: {
            configured: keys.length > 0,
            keys: keys.length,
            maskedKeys: keys.map((k) => maskKey(k)),
            model: "openai/gpt-oss-120b",
          },
          openrouter: {
            configured: Boolean(orKey),
            maskedKey: orKey ? maskKey(orKey) : null,
          },
        },
        model: {
          primary: "openai/gpt-oss-120b",
          note: "pool Groq round-robin + fallback OpenRouter (core/ai/model-router.ts)",
        },
      });
      return;
    }

    // ── Static frontend ──
    const requested = p === "/" ? "/index.html" : p;
    const file = path.resolve(publicDir, `.${requested}`);
    if (file.startsWith(path.resolve(publicDir)) && existsSync(file)) {
      const ext = path.extname(file);
      const type = ext === ".css" ? "text/css" : ext === ".js" ? "text/javascript" : ext === ".json" ? "application/json" : "text/html";
      res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache" });
      res.end(readFileSync(file));
      return;
    }

    send(res, 404, { error: "not found" });
  };

  return { handler, config, agent };
}

export function createAgentServer(options: AgentServerOptions): { server: Server; config: BrainConfig; agent: SingleAgent } {
  const { handler, config, agent } = createAgentHandler(options);
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    });
  });
  return { server, config, agent };
}

function maskKey(key: string): string {
  return key.length <= 4 ? "••••" : `••••••${key.slice(-4)}`;
}

function safeGroqKeys(): string[] {
  try {
    return loadGroqKeys();
  } catch {
    return [];
  }
}

function countGroq(): number {
  return safeGroqKeys().length;
}

// ── Entrypoint standalone (npm run agent) ──
const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const config = loadConfig();
  const port = Number(process.env.PORT ?? process.env.AGENT_PORT ?? "3300");
  const { server } = createAgentServer({ config });
  server.listen(port, String(process.env.HOST ?? "127.0.0.1"), () => {
    process.stdout.write(`Second Brain (Single Agent) on http://127.0.0.1:${port}\n`);
  });
}
