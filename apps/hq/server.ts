import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../core/config/loader.ts";
import { getHqSnapshot, executeHqCommand, dispatchInitiative, requestHandoff, agentProfile, progressSummary } from "../../core/hq/hq-api.ts";
import { recentHqEvents } from "../../core/hq/event-stream.ts";
import { transcribeAudio } from "../../core/audio/transcription.ts";
import { executeEngineeringTask } from "../../core/hq/engineering.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const config = loadConfig();
const port = Number(process.env.HQ_PORT ?? "3200");
const host = process.env.HQ_HOST ?? "127.0.0.1";
const allowedOrigins = (process.env.HQ_CORS_ORIGINS ?? "*").split(",").map((s) => s.trim());

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
    return { status: "healthy", services: { database: tables > 10, agentRegistry: agents > 0, secondBrain: true, hq: true }, checkedAt: new Date().toISOString() };
  } finally { db.close(); }
}

const server = createServer((req, res) => {
  cors(req, res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const url = new URL(req.url ?? "/", `http://${host}:${port}`);
  if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/api/hq/health")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(checkHealth())); return; }
  if (req.method === "GET" && url.pathname === "/api/hq/state") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(getHqSnapshot(config))); return; }
  if (req.method === "GET" && url.pathname === "/api/hq/events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    let lastId = Number(url.searchParams.get("after") ?? "0");
    const tick = () => { for (const event of recentHqEvents(config, lastId)) { lastId = event.id ?? lastId; res.write(`id: ${lastId}\ndata: ${JSON.stringify(event)}\n\n`); } };
    tick(); const timer = setInterval(tick, 1000); req.on("close", () => clearInterval(timer)); return;
  }
  if (req.method === "POST" && url.pathname === "/api/hq/command") {
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); }); req.on("end", () => { try { const result = executeHqCommand(config, String((JSON.parse(body) as { text?: string }).text ?? "")); res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })); } }); return;
  }
  if (req.method === "POST" && url.pathname === "/api/hq/transcribe") {
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); }); req.on("end", async () => { try { const input = JSON.parse(body) as { audio?: string; mimeType?: string; durationMs?: number }; const result = await transcribeAudio({ audio: Buffer.from(input.audio ?? "", "base64"), mimeType: input.mimeType ?? "audio/webm", durationMs: input.durationMs }); let command: ReturnType<typeof executeHqCommand> | undefined; if (result.status === "TRANSCRIBED" && result.text) { command = executeHqCommand(config, result.text); const db = new DatabaseSync(config.dbPath); try { db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('audio_transcription', 'command-center', ?)").run(JSON.stringify({ origin: "audio", durationMs: result.durationMs, confidence: result.confidence, text: result.text, commandOk: command.ok })); } finally { db.close(); } } res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ...result, command })); } catch (error) { res.writeHead(400, { "Content-Type": "application/json" }); res.end(JSON.stringify({ status: "TRANSCRIPTION_FAILED", error: error instanceof Error ? error.message : String(error) })); } }); return;
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
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.resolve(publicDir, `.${requested}`); if (!file.startsWith(path.resolve(publicDir)) || !existsSync(file)) { res.writeHead(404); res.end("Not found"); return; }
  const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
  res.writeHead(200, { "Content-Type": type }); res.end(readFileSync(file));
});
server.listen(port, host, () => process.stdout.write(`Second Brain HQ on http://${host}:${port}\n`));
