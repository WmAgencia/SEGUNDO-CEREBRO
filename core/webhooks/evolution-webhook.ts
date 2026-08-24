import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import {
  ensureCommTables,
  resolveContact,
  resolveConversation,
  saveMessage,
  isDuplicateMessage,
  classifyIntent,
  getCustomerProfile,
  nextBestAction,
  stageForIntent,
  updateCustomerProfile,
} from "../comms/pipeline.ts";
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
): {
  processed: boolean;
  action?: string;
  error?: string;
  intent?: string;
  recipient?: string;
  approval?: { id: number; decision: "APPROVED" | "REJECTED"; customer: string; draft: string };
} {
  if (!body.event || !body.instance) {
    return { processed: false, error: "missing event or instance" };
  }

  const expectedInstance = process.env.EVOLUTION_INSTANCE;
  if (expectedInstance && body.instance.toLowerCase() !== expectedInstance.toLowerCase()) {
    return { processed: false, error: "instance rejected" };
  }

  const event = body.event.toUpperCase().replace(/[.\-\s]+/g, "_");

  const db = new DatabaseSync(config.dbPath);
  try {
    ensureCommTables(db);

    switch (event) {
      case "MESSAGES_UPSERT":
        return processIncomingMessage(db, config, body.data);
      case "CONNECTION_UPDATE":
        logEvent(db, "connection_update", body.instance, {});
        return { processed: true, action: "connection_update_logged" };
      default:
        return { processed: false, action: `ignored:${event}` };
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
): {
  processed: boolean;
  action?: string;
  error?: string;
  intent?: string;
  recipient?: string;
  approval?: { id: number; decision: "APPROVED" | "REJECTED"; customer: string; draft: string };
} {
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
  const content = msgContent.trim();

  const ownerPhone = (process.env.OWNER_WHATSAPP ?? "5515981817336").replace(/\D/g, "");
  if (phone.replace(/\D/g, "") === ownerPhone) {
    const decision = approvalDecision(content);
    if (decision) {
      const pending = db
        .prepare(
          "SELECT id, payload FROM approvals WHERE status='PENDING' AND type='CUSTOMER_MESSAGE' ORDER BY created_at DESC LIMIT 1",
        )
        .get() as { id: number; payload: string } | undefined;
      if (!pending) {
        return { processed: true, action: "approval_command_without_pending_approval" };
      }
      const approvalData = safeObject(pending.payload);
      const customer = String(approvalData.customerPhone ?? "");
      const draft = String(approvalData.proposedResponse ?? "");
      db.prepare(
        `UPDATE approvals SET status=?, resolved_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
         resolved_by=?, decision=? WHERE id=? AND status='PENDING'`,
      ).run(decision, ownerPhone, decision, pending.id);
      logEvent(db, decision === "APPROVED" ? "approval_approved" : "approval_rejected", ownerPhone, {
        approvalId: pending.id,
      });
      return {
        processed: true,
        action: `approval_${decision.toLowerCase()}`,
        approval: { id: pending.id, decision, customer, draft },
      };
    }
  }

  const contact = resolveContact(db, phone, pushName);
  const conversation = resolveConversation(db, contact.id);
  saveMessage(db, conversation.id, externalId, "inbound", msgContent);

  const intent = classifyIntent(msgContent);
  const profile = getCustomerProfile(db, contact.id);
  const next = nextBestAction(intent, profile);
  const contextPackage = buildContextPackage(config, {
    task: `Responder cliente: ${intent}`,
    entity: "project.vyntra",
    depth: 1,
    maxChars: 4000,
  });
  updateCustomerProfile(db, contact.id, {
    sales_stage: stageForIntent(intent),
    next_action: next.action,
    service_interest:
      profile.service_interest === "UNKNOWN" && intent === "SERVICE"
        ? "website_or_system"
        : profile.service_interest,
    objections:
      intent === "OBJECTION" || intent === "NEGOTIATION"
        ? [...new Set([...profile.objections, content])]
        : profile.objections,
  });
  db.prepare(
    "UPDATE wa_conversations SET status='ACTIVE', sales_stage=?, last_intent=?, next_action=? WHERE id=?",
  ).run(stageForIntent(intent), intent, next.action, conversation.id);
  const draft = generateDraft(intent, msgContent);

  if (next.action === "REQUEST_HUMAN") {
    const approval = db
      .prepare(
        `INSERT INTO approvals (initiative_id, agent_id, type, payload, reason)
         VALUES (?, 'sales-agent', 'CUSTOMER_MESSAGE', ?, ?)`,
      )
      .run(
        "project.vyntra",
        JSON.stringify({
          customerPhone: phone,
          customerMessage: content,
          proposedResponse: draft,
          risk: "HIGH",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        }),
        next.reason,
      );
    logEvent(db, "approval_required", phone, { approvalId: Number(approval.lastInsertRowid) });
  }

  saveMessage(db, conversation.id, `draft_${externalId}`, "outbound", draft);
  logEvent(db, "message_received", contact.id.toString(), {
    intent,
    action: next.action,
    confidence: next.confidence,
    conversationId: conversation.id,
  });
  logEvent(db, "context_built", contact.id.toString(), {
    entityId: contextPackage.context.entityId,
    memoryCount: contextPackage.memories.length,
  });
  logEvent(db, "draft_created", null, { taskId: conversation.id });

  return {
    processed: true,
    action: `message_saved|intent=${intent}|draft_generated`,
    intent,
    recipient: phone,
  };
}

function approvalDecision(text: string): "APPROVED" | "REJECTED" | null {
  if (/^(aprovar|aprovado|aceitar|aceito|sim)$/i.test(text)) return "APPROVED";
  if (/^(rejeitar|rejeitado|recusar|recusado|não|nao)$/i.test(text)) return "REJECTED";
  return null;
}

function safeObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
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
