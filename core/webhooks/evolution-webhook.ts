import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../config/loader.ts";
import { ensureCommTables, resolveContact, resolveConversation, saveMessage, isDuplicateMessage, classifyIntent, getCustomerProfile, nextBestAction, nextBestQuestion, stageForIntent, updateCustomerProfile, updateProfileFromMessage } from "../comms/pipeline.ts";
import { redactSecrets } from "../exec/redact.ts";
import { ANA_PHONE, compilePersonalContext, personalReply, qualityGate } from "../personal/personal-agent.ts";
import { setKillSwitch } from "../autonomous/cycle.ts";

const OWNER_PHONE = () => (process.env.OWNER_WHATSAPP ?? "5515981817336").replace(/\D/g, "");
const OPS_GROUP_ID = () => process.env.SECOND_BRAIN_OPERATIONS_GROUP ?? "120363427273069174@g.us";
const SOURCE_ID = "src.system";

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
  approval?: { id: number; decision: string; customer: string; draft: string };
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
  approval?: { id: number; decision: string; customer: string; draft: string };
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
  const content = msgContent.trim();
  const isGroup = remoteJid.includes("@g.us");

  // STRUCTURAL FIX: Only individual chats enter the Sales Flow.
  // Groups are either OPS (owner commands) or OTHER (ignored).
  if (isGroup) {
    const isOpsGroup = remoteJid === OPS_GROUP_ID();
    if (isOpsGroup) {
      const participantPhone = String(String(key.participant ?? "").split("@")[0]).replace(/\D/g, "");
      return handleOwnerCommand(db, config, {
        remoteJid,
        participantPhone,
        content,
      });
    }
    return { processed: false, action: "skipped:other_group_not_sales_flow" };
  }

  // STRUCTURAL FIX: Skip outbound/system messages — they never start Sales Flow.
  const phone = remoteJid.split("@")[0] ?? remoteJid;
  const pushName = String(data?.pushName ?? phone);

  const ownerPhone = OWNER_PHONE();
  if (phone.replace(/\D/g, "") === ownerPhone) {
    return { processed: false, action: "skipped:owner_private_chat_no_admin" };
  }

  if (phone.replace(/\D/g, "") === ANA_PHONE) {
    return processPersonalMessage(db, phone, pushName, externalId, content);
  }

  const contact = resolveContact(db, phone.replace(/\D/g, ""), pushName);
  const conversation = resolveConversation(db, contact.id);
  saveMessage(db, conversation.id, externalId, "inbound", msgContent);

  const intent = classifyIntent(msgContent);
  const profile = getCustomerProfile(db, contact.id);
  const next = nextBestAction(intent, profile);
  const profilePatch = updateProfileFromMessage(profile, content);
  const question = nextBestQuestion({ ...profile, ...profilePatch });

  // Dedup: se já existe approval PENDING para este customer, não criar outra
  const pendingApproval = db
    .prepare(
      "SELECT id FROM approvals WHERE status='PENDING' AND payload LIKE ?",
    )
    .get(`%"customerPhone":"${phone.replace(/\D/g, "")}"%`) as { id: number } | undefined;
  if (pendingApproval && next.action === "REQUEST_HUMAN") {
    logEvent(db, "approval_duplicate_blocked", phone, { approvalId: pendingApproval.id });
    return {
      processed: true,
      action: `approval_already_pending|approval_id=${pendingApproval.id}`,
      intent,
      recipient: phone,
    };
  }

  updateCustomerProfile(db, contact.id, {
    ...profilePatch,
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
    asked_questions:
      question && next.action === "QUALIFY"
        ? [...new Set([...profile.asked_questions, question.key])]
        : profile.asked_questions,
  });
  db.prepare(
    "UPDATE wa_conversations SET status='ACTIVE', sales_stage=?, last_intent=?, next_action=? WHERE id=?",
  ).run(stageForIntent(intent), intent, next.action, conversation.id);
  const draft = generateDraft(intent, msgContent, question);

  if (next.action === "REQUEST_HUMAN") {
    db.prepare(
      `INSERT INTO approvals (initiative_id, agent_id, type, payload, reason)
       VALUES (?, 'sales-agent', 'CUSTOMER_MESSAGE', ?, ?)`,
    ).run(
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
    logEvent(db, "approval_required", phone, { approvalId: null });
  }

  saveMessage(db, conversation.id, `draft_${externalId}`, "outbound", draft);
  logEvent(db, "message_received", contact.id.toString(), {
    intent, action: next.action, confidence: next.confidence, conversationId: conversation.id,
  });
  logEvent(db, "draft_created", null, { taskId: conversation.id });

  return {
    processed: true,
    action: `message_saved|intent=${intent}|draft_generated`,
    intent,
    recipient: phone,
  };
}

function processPersonalMessage(
  db: DatabaseSync,
  phone: string,
  name: string,
  externalId: string,
  content: string,
): { processed: boolean; action: string; recipient: string; intent: string } {
  const contact = resolveContact(db, phone.replace(/\D/g, ""), name);
  const conversation = resolveConversation(db, contact.id);
  saveMessage(db, conversation.id, externalId, "inbound", content);
  const context = compilePersonalContext(db, ANA_PHONE);
  const draft = context ? personalReply(context, content) : { text: "Obrigado por escrever. Podemos conversar mais depois?", confidence: 0 };
  const gate = qualityGate(context, draft.text);
  if (!gate.allowed) {
    logEvent(db, "personal_quality_gate_blocked", ANA_PHONE, { reasons: gate.reasons, confidence: draft.confidence });
    return { processed: true, action: "personal_response_blocked", recipient: phone, intent: "PERSONAL" };
  }
  saveMessage(db, conversation.id, `draft_${externalId}`, "outbound", draft.text);
  logEvent(db, "personal_draft_created", ANA_PHONE, { confidence: draft.confidence, context: "PERSONAL" });
  return { processed: true, action: "personal_draft_generated", recipient: phone, intent: "PERSONAL" };
}

function handleOwnerCommand(
  db: DatabaseSync,
  config: BrainConfig,
  ctx: { remoteJid: string; participantPhone: string; content: string },
): {
  processed: boolean;
  action?: string;
  error?: string;
  intent?: string;
  recipient?: string;
  approval?: { id: number; decision: string; customer: string; draft: string };
} {
  const ownerPhone = OWNER_PHONE();
  const authorized = ctx.participantPhone === ownerPhone;

  logEvent(db, "owner_command_received", ctx.participantPhone, {
    channel: "SECOM",
    authorized,
    command: ctx.content.slice(0, 80),
  });

  if (!authorized) {
    return { processed: true, action: "owner_command_denied_unauthorized_sender" };
  }

  const decision = approvalDecision(ctx.content);
  if (decision) {
    const pending = db
      .prepare("SELECT id, payload FROM approvals WHERE status='PENDING' ORDER BY created_at DESC LIMIT 1")
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
      approvalId: pending.id, actor: "OWNER", channel: "SECOM",
    });
    return {
      processed: true,
      action: `approval_${decision.toLowerCase()}`,
      approval: { id: pending.id, decision, customer, draft },
    };
  }

  const command = ctx.content.replace(/^@brain\s*/i, "").trim();
  if (/^pare tudo$/i.test(command)) {
    activateKillSwitch(db, ownerPhone);
    return { processed: true, action: "kill_switch_activated" };
  }
  if (/^(continue|retomar|resume|retomar agente|resume o agente)$/i.test(command)) {
    setKillSwitch(false);
    logEvent(db, "kill_switch_deactivated", ownerPhone, { channel: "SECOM" });
    return { processed: true, action: "kill_switch_deactivated" };
  }
  if (/^(pausar agente|pause o agente|pause engineering)\s+(.+)$/i.test(command)) {
    const m = /^(pausar agente|pause o agente|pause engineering)\s+(.+)$/i.exec(command);
    if (m?.[2]) pauseAgent(db, m[2].trim());
    return { processed: true, action: "agent_paused" };
  }
  if (/^(retomar agente|resume o agente|resume engineering)\s+(.+)$/i.test(command)) {
    const m = /^(retomar agente|resume o agente|resume engineering)\s+(.+)$/i.exec(command);
    if (m?.[2]) resumeAgent(db, m[2].trim());
    return { processed: true, action: "agent_resumed" };
  }
  if (/status|relat[óo]rio/i.test(command)) {
    return { processed: true, action: "status_report_requested" };
  }

  if (/^(implemente|pesquise|consulte segunda opini[ãa]o)/i.test(command)) {
    return { processed: true, action: "owner_command_queued_in_secom" };
  }
  return { processed: true, action: "owner_command_acknowledged_not_implemented" };
}

function activateKillSwitch(db: DatabaseSync, by: string): void {
  setKillSwitch(true);
  db.prepare("INSERT INTO events (event_type, subject, payload) VALUES ('kill_switch_activated', ?, ?)").run(by, "{}");
}
function pauseAgent(db: DatabaseSync, agentId: string): void {
  db.prepare("UPDATE agents SET status='PAUSED' WHERE id=?").run(agentId);
}
function resumeAgent(db: DatabaseSync, agentId: string): void {
  db.prepare("UPDATE agents SET status='AVAILABLE' WHERE id=?").run(agentId);
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

function generateDraft(
  intent: string,
  _customerMsg: string,
  question: { key: string; text: string } | null,
): string {
  switch (intent) {
    case "GREETING":
      return "Olá! Obrigado pelo contato. Como posso ajudar você hoje?";
    case "PRICE":
      return "Nossos valores variam conforme o escopo do projeto. Posso entender melhor o que você precisa para te passar uma proposta personalizada?";
    case "SERVICE":
      return question?.text ?? "Perfeito. Vou entender o escopo para indicar a melhor solução.";
    case "INTEREST":
      return question?.text ?? "Ótimo. Qual resultado você espera alcançar com esse projeto?";
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
