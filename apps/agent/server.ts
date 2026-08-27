/**
 * Single Agent HTTP server — serves the ChatGPT-like frontend + the agent API.
 * Static files: apps/agent/public
 * API:
 *   GET  /api/health
 *   GET  /api/chat/sessions
 *   POST /api/chat/session                     { title? }
 *   GET  /api/chat/session/:key/messages
 *   POST /api/chat/session/:key/message        { text }
 *   POST /api/chat/session/:key/approve        { toolId, input, approved }
 *   GET  /api/agenda
 *   GET  /api/connections /api/whatsapp/status
 *   GET  /api/images
 *   GET  /api/routing
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

// Load .env.local (same pattern as legacy server)
const envPath = path.resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

import { loadConfig } from "../../core/config/loader.ts";
import { openDatabase, applySchema } from "../../storage/connection.ts";
import { SingleAgent } from "../../core/agent/single-agent.ts";
import { listSessions, ensureSession, getMessages } from "../../core/agent/session-store.ts";
import { loadGroqKeys } from "../../core/ai/model-router.ts";
import { createToolRequestApproval } from "./approval.ts";
import { listAgendaEvents, createAgendaEvent } from "./agenda-api.ts";

const config = loadConfig();
const port = Number(process.env.PORT ?? process.env.AGENT_PORT ?? "3300");
const agent = new SingleAgent();

// ensure schema
{
  const db = openDatabase(config.dbPath);
  applySchema(db);
  db.close();
}

// recover stale orchestration runs (blocked, never auto-resume risky work)
{
  const { recoverAtStartup } = await import("../../core/orchestration/recovery.ts");
  const recovered = recoverAtStartup(config);
  if (recovered.length) {
    process.stdout.write(`[recovery] ${recovered.length} run(s) stale recuperado(s) como BLOCKED\n`);
  }
}

function send(res: ServerResponse, status: number, body: unknown, contentType = "application/json"): void {
  res.writeHead(status, { "Content-Type": contentType, "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" });
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

const server = createServer(async (req, res) => {
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
    send(res, 200, { sessions: listSessions(config) });
    return;
  }
  if (req.method === "POST" && p === "/api/chat/session") {
    const body = await readBody(req);
    const key = String(body.key ?? `chat-${Date.now().toString(36)}`);
    ensureSession(config, key);
    send(res, 200, { sessionKey: key });
    return;
  }

  const sessionMatch = p.match(/^\/api\/chat\/session\/([^/]+)\/messages$/);
  if (req.method === "GET" && sessionMatch?.[1]) {
    const key = decodeURIComponent(sessionMatch[1]!);
    send(res, 200, { messages: getMessages(config, key, 200) });
    return;
  }

  const msgMatch = p.match(/^\/api\/chat\/session\/([^/]+)\/message$/);
  if (req.method === "POST" && msgMatch?.[1]) {
    const key = decodeURIComponent(msgMatch[1]!);
    const body = await readBody(req);
    const text = String(body.text ?? "").trim();
    if (!text) { send(res, 400, { error: "text required" }); return; }
    const result = await agent.chat(config, key, text, createToolRequestApproval(key));
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

  // ── Graphs (painel discreto) ──
  if (req.method === "GET" && p === "/api/graphs") {
    try {
      const { listRuns, listNodes } = await import("../../core/orchestration/graph-store.ts");
      const runs = listRuns(config, undefined, Number(url.searchParams.get("limit") ?? 20));
      const withNodes = runs.map((r) => ({ id: r.id, goal: r.goal, status: r.status, sessionKey: r.sessionKey, request: r.request, nodes: listNodes(config, r.id).map((n) => ({ id: n.id, title: n.title, status: n.status, error: n.error, retryCount: n.retryCount })) }));
      send(res, 200, { runs: withNodes });
    } catch (error) {
      send(res, 200, { runs: [], error: error instanceof Error ? error.message : String(error) });
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
      send(res, 200, { whatsapp: { state, available: await isAvailable() } });
    } catch (error) {
      send(res, 200, { whatsapp: { state: "unconfigured", available: false, error: error instanceof Error ? error.message.slice(0, 120) : String(error) } });
    }
    return;
  }

  // ── Images ──
  if (req.method === "GET" && p === "/api/images") {
    const db = openDatabase(config.dbPath);
    try {
      const rows = db.prepare("SELECT id, payload, occurred_at FROM events WHERE event_type='tool_execution' AND payload LIKE '%image_generate%' ORDER BY id DESC LIMIT 30").all() as Array<{ id: number; payload: string; occurred_at: string }>;
      send(res, 200, { images: rows });
    } finally { db.close(); }
    return;
  }

  // ── Routing / providers ──
  if (req.method === "GET" && p === "/api/routing") {
    send(res, 200, {
      providers: {
        groq: { configured: countGroq() > 0, keys: countGroq() },
        openrouter: { configured: Boolean(process.env.OPENROUTER_API_KEY) },
      },
      model: {
        primary: "openai/gpt-oss-120b",
        note: "administered by core/ai/model-router.ts (pool Groq + fallback OpenRouter)",
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
});

function countGroq(): number {
  try {
    return loadGroqKeys().length;
  } catch {
    return 0;
  }
}

server.listen(port, String(process.env.HOST ?? "127.0.0.1"), () => {
  process.stdout.write(`Second Brain (Single Agent) on http://127.0.0.1:${port}\n`);
});