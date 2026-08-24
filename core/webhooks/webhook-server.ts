import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { applySchema } from "../../storage/connection.ts";
import { handleEvolutionWebhook } from "./evolution-webhook.ts";
import * as evolution from "../comms/evolution-api.ts";
import { upsertAgent } from "../agents/agent-runtime.ts";
import { redactSecrets } from "../exec/redact.ts";

const startTime = Date.now();

export function startServer(config: BrainConfig, port = 3001): void {
  const db = new DatabaseSync(config.dbPath);
  applySchema(db);
  ensureWebhookTables(db);
  ensureSalesAgent(db);
  ensureCommercialProfile(db);
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
            if (result.approval) {
              await processApprovalResult(config, result.approval);
              } else if (result.processed && result.action?.includes("draft_generated")) {
                // Commercial auto-send remains explicitly disabled in this phase.
                await autoSendDraft(config, body, result);
            }
            if (result.processed) await notifyOperations(result.action ?? "webhook_processed");
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

function ensureSalesAgent(db: DatabaseSync): void {
  if (db.prepare("SELECT id FROM agents WHERE id='sales-agent'").get()) return;
  upsertAgent(db, {
    id: "sales-agent",
    name: "Sales & Customer Agent",
    description: "Agente de descoberta, qualificacao e atendimento comercial.",
    domains: ["sales", "customer-support"],
    capabilities: ["qualification", "sales", "customer-support"],
    skills: ["sales", "copywriting"],
    tools: ["brain_search", "brain_context", "brain_remember"],
    projects: [],
    goals: [],
    permissions: ["context", "memory.read"],
    status: "AVAILABLE",
  });
}

function ensureCommercialProfile(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO comm_profiles (owner, context, tone, formality, message_length)
     VALUES ('sales-agent', 'COMMERCIAL', 'consultivo', 'profissional', 'curta')
     ON CONFLICT(owner, context) DO NOTHING`,
  ).run();
}

async function processApprovalResult(
  config: BrainConfig,
  approval: { id: number; decision: string; customer: string; draft: string },
): Promise<void> {
  if (approval.decision !== "APPROVED" || !approval.customer || !approval.draft) return;
  try {
    const sent = await evolution.sendMessage(approval.customer, approval.draft);
    const db = new DatabaseSync(config.dbPath);
    try {
      const row = db
        .prepare("SELECT id FROM wa_conversations WHERE contact_id=(SELECT id FROM wa_contacts WHERE external_id=?) ORDER BY id DESC LIMIT 1")
        .get(approval.customer) as { id: number } | undefined;
      if (row) {
        db.prepare(
          "INSERT INTO wa_messages (conversation_id, external_id, direction, content, timestamp) VALUES (?, ?, 'outbound', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
        ).run(row.id, sent.messageId, approval.draft);
      }
      db.prepare(
        "INSERT INTO events (event_type, subject, payload) VALUES ('message_sent', ?, ?)",
      ).run(approval.customer, JSON.stringify({ approvalId: approval.id, messageId: sent.messageId }));
    } finally {
      db.close();
    }
  } catch (err) {
    const db = new DatabaseSync(config.dbPath);
    try {
      db.prepare(
        "INSERT INTO events (event_type, subject, payload) VALUES ('message_failed', ?, ?)",
      ).run(approval.customer, JSON.stringify({ approvalId: approval.id, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      db.close();
    }
  }
}

async function autoSendDraft(
  config: BrainConfig,
  rawBody: string,
  result: { intent?: string; recipient?: string },
): Promise<void> {
  if (result.intent === "PERSONAL") {
    if (process.env.PERSONAL_AGENT_ENABLED !== "true" || result.recipient?.replace(/\D/g, "") !== "15981142057") return;
    const draft = extractDraftFromDb(config, externalIdOf((JSON.parse(rawBody).data as Record<string, unknown>).key as Record<string, unknown>));
    if (!draft) return;
    const sent = await evolution.sendMessage("15981142057", draft);
    recordOutbound(config, "15981142057", externalIdOf((JSON.parse(rawBody).data as Record<string, unknown>).key as Record<string, unknown>), sent.messageId, draft);
    return;
  }
  // Commercial automation is disabled by policy, not by a user-controlled flag.
  return;
  try {
    const parsed = JSON.parse(rawBody);
    const data = parsed.data as Record<string, unknown> | undefined;
    const key = data?.key as Record<string, unknown> | undefined;
    if (!key || key.fromMe) return;

    const remoteJid = String(key.remoteJid ?? "");
    const phone = remoteJid.split("@")[0];
    if (!phone) return;

    const intent = result.intent ?? "UNKNOWN";

    const AUTONOMOUS_INTENTS = ["GREETING", "QUESTION", "SERVICE", "INTEREST", "FOLLOW_UP"];
    if (!AUTONOMOUS_INTENTS.includes(intent)) {
      // HIGH risk → notify owner instead of sending
      const draft = extractDraftFromDb(config, externalIdOf(key));
      void draft;
      return;
    }

    const draft = extractDraftFromDb(config, externalIdOf(key));
    if (!draft) return;
    const sent = await evolution.sendMessage(result.recipient ?? phone, draft);
    recordOutbound(config, result.recipient ?? phone, externalIdOf(key), sent.messageId, draft);
  } catch {}
}

function recordOutbound(
  config: BrainConfig,
  recipient: string,
  inboundExternalId: string,
  messageId: string,
  content: string,
): void {
  try {
    const db = new DatabaseSync(config.dbPath);
    try {
      const row = db
        .prepare("SELECT conversation_id FROM wa_messages WHERE external_id=?")
        .get(inboundExternalId) as { conversation_id: number } | undefined;
      if (!row) return;
      db.prepare(
        `INSERT OR IGNORE INTO wa_messages
         (conversation_id, external_id, direction, content, timestamp)
         VALUES (?, ?, 'outbound', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      ).run(row.conversation_id, messageId, content);
      db.prepare(
        "INSERT INTO events (event_type, subject, payload) VALUES ('message_sent', ?, ?)",
      ).run(recipient, JSON.stringify({ messageId, inboundExternalId }));
    } finally {
      db.close();
    }
  } catch (err) {
    process.stderr.write(`webhook: outbound audit failed: ${redactSecrets(String(err))}\n`);
  }
}

async function notifyOperations(summary: string): Promise<void> {
  const group = process.env.SECOND_BRAIN_OPERATIONS_GROUP ?? "120363427273069174@g.us";
  try {
    await evolution.sendMessage(group, `SECOND BRAIN\nEVENTO: ${redactSecrets(summary).slice(0, 220)}`);
  } catch {
    // Operational reporting must never block customer processing.
  }
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
