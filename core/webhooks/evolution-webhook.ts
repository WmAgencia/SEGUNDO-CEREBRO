import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { ensureCommTables, resolveContact, resolveConversation, saveMessage, isDuplicateMessage, classifyIntent } from "../comms/pipeline.ts";
import * as evolution from "../comms/evolution-api.ts";
import { buildContextPackage } from "../context/context-package.ts";

export interface WebhookEvent {
  event: string;
  instance: string;
  data?: Record<string, unknown>;
}

export function handleEvolutionWebhook(
  config: BrainConfig,
  body: WebhookEvent,
): { processed: boolean; action?: string; error?: string } {
  if (!body.event || !body.instance) {
    return { processed: false, error: "missing event or instance" };
  }

  const db = new DatabaseSync(config.dbPath);
  try {
    ensureCommTables(db);

    switch (body.event) {
      case "MESSAGES_UPSERT":
        return processIncomingMessage(db, config, body.data);
      case "CONNECTION_UPDATE":
        logEvent(db, "connection_update", body.instance, {});
        return { processed: true, action: "connection_update_logged" };
      default:
        return { processed: false, action: `ignored:${body.event}` };
    }
  } catch (err) {
    return {
      processed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    db.close();
  }
}

function processIncomingMessage(
  db: DatabaseSync,
  config: BrainConfig,
  data?: Record<string, unknown>,
): { processed: boolean; action?: string; error?: string } {
  const key = (data?.key as Record<string, unknown>) ?? {};
  const externalId = String(key.id ?? "");
  const fromMe = Boolean(key.fromMe);
  if (!externalId || fromMe) {
    return { processed: false, action: "skipped:from_me_or_no_id" };
  }
  if (isDuplicateMessage(db, externalId)) {
    return { processed: false, action: "duplicate_ignored" };
  }

  const msgContent =
    (data?.message as Record<string, unknown>)?.conversation ??
    ((data?.message as Record<string, unknown>)?.extendedTextMessage as Record<string, unknown>)?.text ??
    "";
  if (typeof msgContent !== "string" || msgContent.trim() === "") {
    return { processed: false, action: "no_text_content" };
  }

  const remoteJid = String(key.remoteJid ?? "");
  const phone = remoteJid.split("@")[0] ?? remoteJid;
  const pushName = String(data?.pushName ?? phone);

  const contact = resolveContact(db, phone, pushName);
  const conversation = resolveConversation(db, contact.id);
  saveMessage(db, conversation.id, externalId, "inbound", msgContent);

  const intent = classifyIntent(msgContent);
  const draft = generateDraft(intent, msgContent);

  saveMessage(db, conversation.id, `draft_${externalId}`, "outbound", draft);
  logEvent(db, "message_received", contact.id.toString(), {
    intent, conversationId: conversation.id,
  });
  logEvent(db, "draft_created", null, { taskId: conversation.id });

  return {
    processed: true,
    action: `message_saved|intent=${intent}|draft_generated`,
  };
}

function generateDraft(intent: string, _customerMsg: string): string {
  switch (intent) {
    case "GREETING":
      return "Olá! Obrigado pelo contato. Como posso ajudar você hoje?";
    case "PRICE":
      return "Nossos valores variam conforme o escopo do projeto. Posso entender melhor o que você precisa para te passar uma proposta personalizada?";
    case "SERVICE":
      return "Trabalhamos com criação de sites, sistemas e automações. Que tipo de solução você está buscando?";
    case "INTEREST":
      return "Que ótimo! Me conta mais sobre seu projeto que eu te mostro como podemos ajudar.";
    case "OBJECTION":
      return "Entendo sua preocupação. Cada projeto é único e trabalhamos com propostas personalizadas. Podemos conversar melhor sobre isso?";
    default:
      return "Obrigado pelo contato! Em que posso ajudar?";
  }
}

function logEvent(
  db: DatabaseSync,
  eventType: string,
  subject: string | null,
  payload: Record<string, unknown>,
): void {
  db.prepare("INSERT INTO events (event_type, subject, payload) VALUES (?, ?, ?)")
    .run(eventType, subject, JSON.stringify(payload));
}

export function startWebhookServer(config: BrainConfig, port = 3001): void {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url?.includes("/webhooks/evolution")) {
      let body = "";
      req.on("data", (chunk) => { body += chunk; });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body) as WebhookEvent;
          const result = handleEvolutionWebhook(config, parsed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
        } catch {
          res.writeHead(400).end('{"error":"invalid JSON"}');
        }
      });
    } else {
      res.writeHead(404).end();
    }
  });
  server.listen(port);
}
