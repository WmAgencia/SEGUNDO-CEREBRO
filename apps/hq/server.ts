import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../../core/config/loader.ts";
import { getHqSnapshot, executeHqCommand } from "../../core/hq/hq-api.ts";

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, "public");
const config = loadConfig();
const port = Number(process.env.HQ_PORT ?? "3200");
const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  if (req.method === "GET" && url.pathname === "/api/hq/state") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(getHqSnapshot(config))); return; }
  if (req.method === "POST" && url.pathname === "/api/hq/command") {
    let body = ""; req.on("data", (chunk) => { body += chunk.toString(); }); req.on("end", () => { try { const result = executeHqCommand(config, String((JSON.parse(body) as { text?: string }).text ?? "")); res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" }); res.end(JSON.stringify(result)); } catch (error) { res.writeHead(500, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) })); } }); return;
  }
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.resolve(publicDir, `.${requested}`); if (!file.startsWith(path.resolve(publicDir)) || !existsSync(file)) { res.writeHead(404); res.end("Not found"); return; }
  const type = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
  res.writeHead(200, { "Content-Type": type }); res.end(readFileSync(file));
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`Second Brain HQ on http://127.0.0.1:${port}\n`));
