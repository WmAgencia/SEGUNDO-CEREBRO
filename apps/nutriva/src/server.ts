import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initNutrivaSchema } from "./db/nutriva-schema.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const db = new DatabaseSync(path.join(__dirname, "..", "data", "nutriva.db"));
initNutrivaSchema(db);

const PORT = Number(process.env.NUTRIVA_PORT ?? "3100");

const server = createServer(async (req, res) => {
  const url = req.url ?? "";

  if (req.method === "GET" && url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", product: "nutriva", version: "0.1.0" }));
    return;
  }

  if (req.method === "GET" && url === "/api/tenants") {
    const rows = db.prepare("SELECT * FROM tenants ORDER BY id").all();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(rows));
    return;
  }

  if (req.method === "POST" && url === "/api/tenants") {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try {
        const input = JSON.parse(body) as { name?: string; email?: string };
        if (!input.name || !input.email) {
          res.writeHead(400).end(JSON.stringify({ error: "name and email required" }));
          return;
        }
        const result = db.prepare(
          "INSERT INTO tenants (name, email) VALUES (?, ?)"
        ).run(input.name, input.email);
        const tenant = db.prepare("SELECT * FROM tenants WHERE id = ?").get(result.lastInsertRowid);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify(tenant));
      } catch (e) {
        res.writeHead(400).end(JSON.stringify({ error: e instanceof Error ? e.message : "error" }));
      }
    });
    return;
  }

  res.writeHead(404).end('{"error":"not found"}');
});

server.listen(PORT, () => {
  console.log(`nutriva server on :${PORT}`);
});
