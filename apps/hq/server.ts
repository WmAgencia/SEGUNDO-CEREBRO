import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load .env.local before anything else
const envPath = path.resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}
console.log(`[env] OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY ? "present" : "MISSING"}`);

import { loadConfig } from "../../core/config/loader.ts";
import { openDatabase, applySchema } from "../../storage/connection.ts";
import { getHqSnapshot, executeHqCommand, dispatchInitiative, requestHandoff, agentProfile, progressSummary } from "../../core/hq/hq-api.ts";
import { recentHqEvents } from "../../core/hq/event-stream.ts";
import { handleNutrivaRequest } from "../nutriva/src/server.ts";
import { transcribeAudio } from "../../core/audio/transcription.ts";
import { executeEngineeringTask } from "../../core/hq/engineering.ts";
import { listNotifications, unreadCount, markRead, markAllRead, createNotification } from "../../core/hq/notifications.ts";
import { runInitiativeAutonomously } from "../../core/hq/autonomous-executor.ts";
import { getInstance as getWhatsAppInstance, setAiEnabled as setInstanceAiEnabled, setConnected as setInstanceConnected } from "../../core/comms/instance-state.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const config = loadConfig();
const port = Number(process.env.PORT ?? process.env.HQ_PORT ?? "3200");
const host = process.env.HQ_HOST ?? "127.0.0.1";
const allowedOrigins = (process.env.HQ_CORS_ORIGINS ?? "*").split(",").map((s) => s.trim());

// Initialize database schema at startup (idempotent)
const initDb = openDatabase(config.dbPath);
applySchema(initDb);
initDb.close();

function cors(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  const origin = req.headers.origin ?? "";
  if (allowedOrigins.includes("*") || allowedOrigins.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin || "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function checkHealth(): Record<string, unknown> {
  const db = new DatabaseSync(config.dbPath);
  try {
    const tables = Number((db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get() as { n: number }).n);
    const agents = Number((db.prepare("SELECT COUNT(*) AS n FROM agents").get() as { n: number }).n);
    return { status: "healthy", version: "scale-19", services: { database: tables > 10, agentRegistry: agents > 0, secondBrain: true, hq: true }, checkedAt: new Date().toISOString() };
  } finally { db.close(); }
}

const server = createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  if (url.pathname === "/nutriva" || url.pathname.startsWith("/nutriva/")) {
    const inner = url.pathname.replace(/^\/nutriva/, "") || "/";
    handleNutrivaRequest(req, res, inner).catch(() => { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: "nutriva internal error" })); });
    return;
  }

  // Debug endpoint for operational status
  if (req.method === "GET" && url.pathname === "/api/hq/debug/status") {
    const t = "quem está trabalhando";
    const db = new DatabaseSync(config.dbPath);
    try {
      const rows = db.prepare("SELECT assigned_agent AS agent_id, title FROM initiative_tasks WHERE status='RUNNING' AND assigned_agent IS NOT NULL ORDER BY id").all() as Array<{agent_id:string;title:string}>;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ 
        testRegex: /quem\s+(est[áa]\s+)?(trabalhando|ocupado|executando)/i.test("quem está trabalhando"),
        isQuestion: /\?|como est|qual|quais|quem|o que|quantos|em que etapa|por que|pr[oó]xim/i.test("quem está trabalhando"),
        whoMatch: /quem\s+(est[áa]\s+)?(trabalhando|ocupado|executando)/i.test("quem está trabalhando"),
        runningTasks: (new DatabaseSync(config.dbPath).prepare("SELECT assigned_agent AS agent_id, title FROM initiative_tasks WHERE status='RUNNING' AND assigned_agent IS NOT NULL ORDER BY id").all() as Array<{agent_id:string;title:string}>).length,
        rows
      }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
    }
    return;
  }
  
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/hq/health")) {
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(checkHealth())); return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/hq/agent/") && url.pathname.endsWith("/logs")) {
    const agentId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(config.dbPath);
      const rows = db.prepare("SELECT stage, message, created_at FROM agent_task_logs WHERE agent_id = ? ORDER BY id DESC LIMIT 60").all(agentId);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, agentId, logs: rows.reverse() }));
    } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: String(error) })); }
    finally { db?.close(); }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/hq/agents/rename") {
    let body = ""; req.on("data", (c) => { body += c.toString(); }); req.on("end", () => {
      try {
        const input = JSON.parse(body) as { id?: string; name?: string };
        if (!input.id || !input.name?.trim()) throw new Error("id e name obrigatorios");
        const db = new DatabaseSync(config.dbPath);
        try { db.prepare("UPDATE agents SET name = ? WHERE id = ?").run(input.name.trim().slice(0, 40), input.id); } finally { db.close(); }
        res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, id: input.id, name: input.name.trim() }));
      } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); }
    }); return;
  }

  if (req.method === "GET" && url.pathname === "/api/hq/state") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(getHqSnapshot(config))); return; }

  // ── WhatsApp multi-instance proxy (Evolution API) ──
  if (url.pathname.startsWith("/api/whatsapp/")) {
    void (async () => {
      const wa = (p: string, init?: RequestInit) => fetch(`${process.env.EVOLUTION_API_URL}${p}`, {
        ...init,
        headers: { apikey: process.env.EVOLUTION_API_KEY ?? "", "Content-Type": "application/json", ...(init?.headers ?? {}) },
        signal: AbortSignal.timeout(60_000),
      });
      const send = (status: number, data: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(data)); };
      try {
        if (!process.env.EVOLUTION_API_URL) return send(503, { error: "EVOLUTION_API_URL não configurada" });
        const sub = url.pathname.slice("/api/whatsapp".length);
        if (req.method === "GET" && sub === "/instances") {
          const r = await wa("/instance/fetchInstances");
          const raw = await r.json();
          const db = new DatabaseSync(config.dbPath);
          try {
            const list = (Array.isArray(raw) ? raw : []).map((i: { name?: string; instanceName?: string; state?: string; connectionStatus?: string }) => {
              const name = i.name ?? i.instanceName ?? "?";
              const local = getWhatsAppInstance(db, name);
              const connected = (i.state ?? i.connectionStatus ?? "unknown") === "open";
              if (local.connected !== connected) setInstanceConnected(db, name, connected);
              return { name, state: i.state ?? i.connectionStatus ?? "unknown", aiEnabled: local.aiEnabled, assignedAgent: local.assignedAgent };
            });
            return send(200, { instances: list });
          } finally { db.close(); }
        }
        const aiMatch = sub.match(/^\/ai\/(.+)$/);
        let body = "";
        req.on("data", (c: Buffer) => { body += c.toString(); });
        await new Promise<void>((resolve) => req.on("end", () => resolve()));
        const input = body ? (JSON.parse(body) as Record<string, unknown>) : {};
        if (req.method === "POST" && aiMatch) {
          const enabled = Boolean((input as { enabled?: boolean }).enabled);
          const agent = typeof (input as { assignedAgent?: string }).assignedAgent === "string" ? (input as { assignedAgent?: string }).assignedAgent : undefined;
          const db = new DatabaseSync(config.dbPath);
          try {
            const inst = setInstanceAiEnabled(db, decodeURIComponent(aiMatch[1]!), enabled, agent);
            return send(200, { ok: true, instance: inst });
          } finally { db.close(); }
        }
        if (req.method === "POST" && sub === "/create") {
          const existing = await (await wa("/instance/fetchInstances")).json() as Array<{ name?: string; instanceName?: string }>;
          const names = new Set(existing.map((i) => i.name ?? i.instanceName));
          let n = 1; while (names.has(`whatsapp-${n}`)) n++;
          const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().replace(/\s+/g, "-") : `whatsapp-${n}`;
          await wa("/instance/create", { method: "POST", body: JSON.stringify({ instanceName: name }) });
          const conn = await wa(`/instance/connect/${name}`);
          const connData = (await conn.json()) as Record<string, unknown>;
          return send(201, { name, ...connData });
        }
        const connectMatch = sub.match(/^\/connect\/(.+)$/);
        if (req.method === "GET" && connectMatch) {
          const r = await wa(`/instance/connect/${connectMatch[1]}`);
          return send(r.status, await r.json());
        }
        const stateMatch = sub.match(/^\/state\/(.+)$/);
        if (req.method === "GET" && stateMatch) {
          const r = await wa(`/instance/connectionState/${stateMatch[1]}`);
          return send(r.status, await r.json());
        }
        send(404, { error: "rota whatsapp desconhecida" });
      } catch (error) { send(500, { error: error instanceof Error ? error.message : String(error) }); }
    })();
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/hq/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    let lastId = Number(url.searchParams.get("after") ?? "0");
    const tick = () => { for (const event of recentHqEvents(config, lastId)) { lastId = event.id ?? lastId; res.write(`id: ${lastId}\ndata: ${JSON.stringify(event)}\n\n`); } };
    tick(); const timer = setInterval(tick, 1000); req.on("close", () => clearInterval(timer)); return;
  }
  if (req.method === "POST" && url.pathname === "/api/hq/command") {
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); }); req.on("end", async () => { try { const result = await executeHqCommand(config, String((JSON.parse(body) as { text?: string }).text ?? "")); res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })); } }); return;
  }
  if (req.method === "POST" && url.pathname === "/api/hq/transcribe") {
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); }); req.on("end", async () => { try { const input = JSON.parse(body) as { audio?: string; mimeType?: string; durationMs?: number }; const result = await transcribeAudio({ audio: Buffer.from(input.audio ?? "", "base64"), mimeType: input.mimeType ?? "audio/webm", durationMs: input.durationMs }); let command: Awaited<ReturnType<typeof executeHqCommand>> | undefined; if (result.status === "TRANSCRIBED" && result.text) { command = await executeHqCommand(config, result.text); const db = new DatabaseSync(config.dbPath); try { db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('audio_transcription', 'command-center', ?)").run(JSON.stringify({ origin: "audio", durationMs: result.durationMs, confidence: result.confidence, text: result.text, commandOk: command.ok })); } finally { db.close(); } } res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ...result, command })); } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "TRANSCRIPTION_FAILED", error: error instanceof Error ? error.message : String(error) })); } }); return;
  }
  if (req.method === "POST" && url.pathname === "/api/hq/execute") {
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); }); req.on("end", async () => { try { const input = JSON.parse(body) as { taskId?: number; agentId?: string; workspacePath?: string; task?: string }; if (!input.taskId || !input.agentId || !input.workspacePath || !input.workspacePath.toLowerCase().includes("apps\\nutriva") && !input.workspacePath.toLowerCase().includes("apps/nutriva")) throw new Error("only Nutriva workspace is allowed"); const result = await executeEngineeringTask(config, { taskId: input.taskId, agentId: input.agentId, workspacePath: input.workspacePath, task: input.task }); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "FAILED", error: error instanceof Error ? error.message : String(error) })); } }); return;
  }
  if (req.method === "POST" && url.pathname === "/api/hq/dispatch") {
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); }); req.on("end", () => { try { const input = JSON.parse(body) as { initiativeId?: string; agentId?: string }; if (!input.initiativeId) throw new Error("initiativeId is required"); const result = dispatchInitiative(config, input.initiativeId, input.agentId ?? "manager"); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ assigned: false, error: error instanceof Error ? error.message : String(error) })); } }); return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/hq/agent/")) {
    const agentId = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    const profile = agentProfile(config, agentId);
    res.writeHead(profile ? 200 : 404, { "Content-Type": "application/json" }); res.end(JSON.stringify(profile ?? { error: "not found" })); return;
  }
  if (req.method === "GET" && url.pathname === "/api/hq/progress") {
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(progressSummary(config))); return;
  }
  if (req.method === "POST" && url.pathname === "/api/hq/handoff") {
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); }); req.on("end", () => { try { const input = JSON.parse(body) as { fromAgent?: string; toAgent?: string; summary?: string; taskId?: number; initiativeId?: string }; if (!input.fromAgent || !input.toAgent || !input.summary) throw new Error("fromAgent, toAgent and summary are required"); const result = requestHandoff(config, input as Parameters<typeof requestHandoff>[1]); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ accepted: false, error: error instanceof Error ? error.message : String(error) })); } }); return;
  }
  if (req.method === "GET" && url.pathname === "/api/hq/notifications") {
    const db = new DatabaseSync(config.dbPath);
    try { const unreadOnly = url.searchParams.get("unread") === "true"; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ notifications: listNotifications(db, unreadOnly), unread: unreadCount(db) })); } finally { db.close(); } return;
  }
  if (req.method === "POST" && url.pathname === "/api/hq/notifications/read-all") {
    const db = new DatabaseSync(config.dbPath);
    try { markAllRead(db); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); } finally { db.close(); } return;
  }
  if (req.method === "POST" && url.pathname?.startsWith("/api/hq/notifications/") && url.pathname.endsWith("/read")) {
    const id = Number(url.pathname.split("/")[4]); const db = new DatabaseSync(config.dbPath);
    try { markRead(db, id); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true })); } finally { db.close(); } return;
  }
  if (req.method === "POST" && url.pathname === "/api/hq/autonomous-run") {
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); }); req.on("end", async () => { try { const input = JSON.parse(body) as { initiativeId?: string; workspacePath?: string }; if (!input.initiativeId) throw new Error("initiativeId is required"); const workspace = input.workspacePath ?? path.resolve(process.cwd(), "apps", "nutriva"); const results = await runInitiativeAutonomously(config, input.initiativeId, workspace); res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, results })); } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); } }); return;
  }
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.resolve(publicDir, `.${requested}`); if (!file.startsWith(path.resolve(publicDir)) || !existsSync(file)) { res.writeHead(404); res.end("Not found"); return; }
  const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
  res.writeHead(200, { "Content-Type": type }); res.end(readFileSync(file));
});
server.listen(port, host, () => process.stdout.write(`Second Brain HQ on http://${host}:${port}\n`));
