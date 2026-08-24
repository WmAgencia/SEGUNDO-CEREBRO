import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { applySchema } from "../../storage/connection.ts";
import { handleEvolutionWebhook } from "./evolution-webhook.ts";
import * as evolution from "../comms/evolution-api.ts";

const startTime = Date.now();

export function startServer(config: BrainConfig, port = 3001): void {
  const db = new DatabaseSync(config.dbPath);
  applySchema(db);
  ensureWebhookTables(db);
  db.close();

  const server = createServer(async (req, res) => {
    const url = req.url ?? "";

    if (req.method === "GET" && url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        version: "3.1.0",
        uptime_s: Math.round((Date.now() - startTime) / 1000),
      }));
      return;
    }

    if (req.method === "GET" && url === "/health/evolution") {
      try {
        const state = await evolution.getConnectionState();
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ evolution: state, instance: process.env.EVOLUTION_INSTANCE }));
      } catch {
        res.writeHead(503).end(JSON.stringify({ evolution: "UNAVAILABLE" }));
      }
      return;
    }

    if (req.method === "POST" && url.includes("/webhooks/evolution")) {
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", async () => {
        try {
          const payload = JSON.parse(body);
          const events = Array.isArray(payload) ? payload : [payload];
          const results = events.map((evt) =>
            handleEvolutionWebhook(config, evt),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, results }));

          // Auto-send drafts for LOW-risk autonomous replies
          for (const result of results) {
            if (result.processed && result.action?.includes("draft_generated")) {
              await autoSendDraft(config, body);
            }
          }
        } catch {
          res.writeHead(400).end('{"error":"invalid JSON"}');
        }
      });
      return;
    }

    res.writeHead(404).end();
  });

  server.listen(port, () => {
    process.stdout.write(`webhook server listening on :${port}\n`);
  });
}

async function autoSendDraft(config: BrainConfig, rawBody: string): Promise<void> {
  try {
    const parsed = JSON.parse(rawBody);
    const data = parsed.data as Record<string, unknown> | undefined;
    const key = data?.key as Record<string, unknown> | undefined;
    if (!key || key.fromMe) return;

    const remoteJid = String(key.remoteJid ?? "");
    const phone = remoteJid.split("@")[0];
    if (!phone) return;

    const intentMatch = /intent=(\w+)/.exec(
      JSON.stringify(parsed.data?._parsed ?? ""),
    );
    const intent = intentMatch?.[1] ?? "UNKNOWN";

    const AUTONOMOUS_INTENTS = ["GREETING", "QUESTION", "SERVICE", "INTEREST", "FOLLOW_UP"];
    if (!AUTONOMOUS_INTENTS.includes(intent)) {
      // HIGH risk → notify owner instead of sending
      const draft = extractDraftFromDb(config, externalIdOf(key));
      if (draft) {
        await evolution.sendMessage(
          process.env.OWNER_WHATSAPP ?? "5515981817336",
          `Cliente: ${phone}\nMensagem: ${msgContent(data)}\n\nResposta sugerida:\n${draft}\n\nAção: APROVAR / REJEITAR`,
        );
      }
      return;
    }

    const draft = extractDraftFromDb(config, externalIdOf(key));
    if (!draft) return;
    await evolution.sendMessage(phone, draft);
  } catch {}
}

function externalIdOf(key: Record<string, unknown>): string {
  return String(key.id ?? "");
}

function msgContent(data?: Record<string, unknown>): string {
  const msg = data?.message as Record<string, unknown> | undefined;
  return String(msg?.conversation ?? msg?.extendedTextMessage ? (msg.extendedTextMessage as Record<string, unknown>)?.text ?? "" : "");
}

function extractDraftFromDb(config: BrainConfig, externalId: string): string | null {
  try {
    const db = new DatabaseSync(config.dbPath);
    const row = db
      .prepare(
        `SELECT content FROM wa_messages
         WHERE conversation_id = (SELECT conversation_id FROM wa_messages WHERE external_id = ?)
         AND direction='outbound' ORDER BY id DESC LIMIT 1`,
      )
      .get(externalId) as { content: string } | undefined;
    db.close();
    return row?.content ?? null;
  } catch {
    return null;
  }
}

function ensureWebhookTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT UNIQUE NOT NULL,
      name TEXT,
      phone TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS wa_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES wa_contacts(id),
      status TEXT NOT NULL DEFAULT 'NEW',
      last_message_at TEXT,
      last_direction TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS wa_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL REFERENCES wa_conversations(id),
      external_id TEXT UNIQUE,
      direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
      content TEXT NOT NULL,
      timestamp TEXT,
      processed INTEGER NOT NULL DEFAULT 0
    );
  `);
}
