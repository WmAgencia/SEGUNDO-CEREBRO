import { DatabaseSync } from "node:sqlite";

export function ensureCommTables(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS wa_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id TEXT UNIQUE NOT NULL,
      name TEXT,
      phone TEXT,
      metadata TEXT DEFAULT '{}',
      profile TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS wa_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contact_id INTEGER NOT NULL REFERENCES wa_contacts(id),
      status TEXT NOT NULL DEFAULT 'NEW',
      last_message_at TEXT,
      last_direction TEXT,
      summary TEXT DEFAULT '',
      sales_stage TEXT NOT NULL DEFAULT 'NEW',
      last_intent TEXT,
      next_action TEXT,
      qualification_score REAL,
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
      ,intent TEXT
      ,recommended_action TEXT
    );
  `);
  for (const statement of [
    "ALTER TABLE wa_contacts ADD COLUMN profile TEXT DEFAULT '{}'",
    "ALTER TABLE wa_conversations ADD COLUMN summary TEXT DEFAULT ''",
    "ALTER TABLE wa_conversations ADD COLUMN sales_stage TEXT NOT NULL DEFAULT 'NEW'",
    "ALTER TABLE wa_conversations ADD COLUMN last_intent TEXT",
    "ALTER TABLE wa_conversations ADD COLUMN next_action TEXT",
    "ALTER TABLE wa_conversations ADD COLUMN qualification_score REAL",
    "ALTER TABLE wa_messages ADD COLUMN intent TEXT",
    "ALTER TABLE wa_messages ADD COLUMN recommended_action TEXT",
  ]) {
    try { db.exec(statement); } catch {}
  }
}

export interface InternalMessage {
  id: number;
  conversationId: number;
  contactExternalId: string;
  contactName: string;
  content: string;
  direction: "inbound" | "outbound";
}

export function resolveContact(
  db: DatabaseSync,
  externalId: string,
  name?: string,
): { id: number; isNew: boolean } {
  const existing = db
    .prepare("SELECT id FROM wa_contacts WHERE external_id = ?")
    .get(externalId) as { id: number } | undefined;
  if (existing) return { id: existing.id, isNew: false };

  const inserted = db
    .prepare("INSERT INTO wa_contacts (external_id, name) VALUES (?, ?)")
    .run(externalId, name ?? null);
  return { id: Number(inserted.lastInsertRowid), isNew: true };
}

export function resolveConversation(
  db: DatabaseSync,
  contactId: number,
): { id: number; isNew: boolean } {
  const existing = db
    .prepare(
      "SELECT id FROM wa_conversations WHERE contact_id = ? AND status != 'WON' AND status != 'LOST' ORDER BY id DESC LIMIT 1",
    )
    .get(contactId) as { id: number } | undefined;
  if (existing) return { id: existing.id, isNew: false };

  const inserted = db
    .prepare("INSERT INTO wa_conversations (contact_id, status) VALUES (?, 'NEW')")
    .run(contactId);
  return { id: Number(inserted.lastInsertRowid), isNew: true };
}

export function saveMessage(
  db: DatabaseSync,
  conversationId: number,
  externalId: string,
  direction: "inbound" | "outbound",
  content: string,
): number {
  const inserted = db
    .prepare(
      `INSERT INTO wa_messages (conversation_id, external_id, direction, content, timestamp)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    )
    .run(conversationId, externalId, direction, content);
  db.prepare(
    `UPDATE wa_conversations SET last_message_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
     last_direction=? WHERE id=?`,
  ).run(direction, conversationId);
  return Number(inserted.lastInsertRowid);
}

export interface CustomerProfile {
  name: string;
  company: string;
  business_segment: string;
  service_interest: string;
  problem: string;
  desired_outcome: string;
  urgency: string;
  budget: string;
  authority: string;
  timeline: string;
  current_solution: string;
  objections: string[];
  preferences: string[];
  lead_source: string;
  sales_stage: string;
  qualification_score: number | null;
  next_action: string;
  asked_questions: string[];
}

export function emptyCustomerProfile(name = "UNKNOWN"): CustomerProfile {
  return {
    name,
    company: "UNKNOWN",
    business_segment: "UNKNOWN",
    service_interest: "UNKNOWN",
    problem: "UNKNOWN",
    desired_outcome: "UNKNOWN",
    urgency: "UNKNOWN",
    budget: "UNKNOWN",
    authority: "UNKNOWN",
    timeline: "UNKNOWN",
    current_solution: "UNKNOWN",
    objections: [],
    preferences: [],
    lead_source: "WhatsApp",
    sales_stage: "NEW",
    qualification_score: null,
    next_action: "DISCOVER",
    asked_questions: [],
  };
}

export function getCustomerProfile(db: DatabaseSync, contactId: number): CustomerProfile {
  const row = db.prepare("SELECT name, profile FROM wa_contacts WHERE id=?").get(contactId) as
    | { name: string | null; profile: string | null }
    | undefined;
  const profile = emptyCustomerProfile(row?.name ?? "UNKNOWN");
  try {
    const parsed = JSON.parse(row?.profile ?? "{}") as Partial<CustomerProfile>;
    return { ...profile, ...parsed, name: parsed.name ?? profile.name };
  } catch {
    return profile;
  }
}

export function updateCustomerProfile(
  db: DatabaseSync,
  contactId: number,
  patch: Partial<CustomerProfile>,
): CustomerProfile {
  const profile = { ...getCustomerProfile(db, contactId), ...patch };
  db.prepare(
    "UPDATE wa_contacts SET profile=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?",
  ).run(JSON.stringify(profile), contactId);
  return profile;
}

export function nextBestAction(intent: Intent, profile: CustomerProfile): {
  action: string;
  reason: string;
  confidence: number;
} {
  if (intent === "GREETING") return { action: "ASK_QUESTION", reason: "iniciar descoberta", confidence: 0.95 };
  if (intent === "SERVICE" || intent === "INTEREST") {
    if (profile.service_interest === "UNKNOWN") return { action: "QUALIFY", reason: "interesse ainda não detalhado", confidence: 0.9 };
    return { action: "PRESENT_SOLUTION", reason: "serviço identificado", confidence: 0.82 };
  }
  if (intent === "PRICE") return { action: "QUALIFY", reason: "preço depende de escopo autorizado", confidence: 0.9 };
  if (intent === "OBJECTION" || intent === "NEGOTIATION") return { action: "REQUEST_HUMAN", reason: "negociação exige aprovação", confidence: 0.98 };
  if (intent === "SCHEDULING") return { action: "SCHEDULE", reason: "cliente sinalizou agendamento", confidence: 0.9 };
  if (intent === "COMPLAINT") return { action: "REQUEST_HUMAN", reason: "cliente potencialmente insatisfeito", confidence: 0.95 };
  return { action: "ASK_QUESTION", reason: "informação insuficiente", confidence: 0.65 };
}

export function updateProfileFromMessage(
  profile: CustomerProfile,
  message: string,
): Partial<CustomerProfile> {
  const lower = message.toLowerCase();
  const patch: Partial<CustomerProfile> = {};
  if (/(site|landing page)/i.test(lower)) {
    patch.service_interest = "website";
  }
  if (/(meu serviço|meu servico|meus serviços|meus servicos|consultório|consultorio)/i.test(lower)) {
    patch.desired_outcome = "apresentar serviços e fortalecer presença digital";
  }
  if (/(clínica|clinica|psicólog|psicolog|massoter|dent|advogad|loja|restaurante)/i.test(lower)) {
    const segment = lower.match(/(clínica|clinica|psicólog\w*|massoter\w*|dent\w*|advogad\w*|loja|restaurante)/i)?.[1];
    if (segment) patch.business_segment = segment;
  }
  if (/(urgente|este mês|esse mês|essa semana|rápido|rapido)/i.test(lower)) {
    patch.urgency = "high";
  }
  if (/(não tenho orçamento|nao tenho orçamento|sem dinheiro|r\$\s*\d+)/i.test(lower)) {
    patch.budget = lower.match(/r\$\s*\d+[\d,.]*/i)?.[0] ?? "limited";
  }
  return patch;
}

export function nextBestQuestion(profile: CustomerProfile): {
  key: string;
  text: string;
} | null {
  const questions: Array<{ key: string; missing: boolean; text: string }> = [
    {
      key: "business_segment",
      missing: profile.business_segment === "UNKNOWN",
      text: "Qual é o seu segmento ou tipo de negócio?",
    },
    {
      key: "desired_outcome",
      missing: profile.desired_outcome === "UNKNOWN",
      text: "O principal objetivo é apresentar seus serviços, vender online, receber agendamentos ou outra coisa?",
    },
    {
      key: "urgency",
      missing: profile.urgency === "UNKNOWN",
      text: "Você pretende colocar o site no ar em algum prazo específico?",
    },
  ];
  return questions.find((q) => q.missing && !profile.asked_questions.includes(q.key)) ?? null;
}

export function stageForIntent(intent: Intent): string {
  switch (intent) {
    case "GREETING": return "DISCOVERY";
    case "SERVICE":
    case "INTEREST": return "SOLUTION";
    case "PRICE": return "PRICE";
    case "OBJECTION": return "OBJECTION";
    case "NEGOTIATION": return "NEGOTIATION";
    case "SCHEDULING": return "SCHEDULING";
    case "FOLLOW_UP": return "FOLLOW_UP";
    case "COMPLAINT":
    case "SUPPORT": return "BLOCKED";
    default: return "DISCOVERY";
  }
}

export function isDuplicateMessage(db: DatabaseSync, externalId: string): boolean {
  return !!db.prepare("SELECT id FROM wa_messages WHERE external_id = ?").get(externalId);
}

export type Intent =
  | "GREETING" | "QUESTION" | "PRICE" | "SERVICE" | "INTEREST"
  | "OBJECTION" | "NEGOTIATION" | "SCHEDULING" | "SUPPORT"
  | "COMPLAINT" | "FOLLOW_UP" | "UNKNOWN";

export function classifyIntent(text: string): Intent {
  const lower = text.toLowerCase();
  if (/quanto custa|pre[çc]o|valor|or[çc]amento|investimento/i.test(lower)) return "PRICE";
  if (/site|landing|sistema|aplicativo|app|desenvolv/i.test(lower)) return "SERVICE";
  if (/caro|barato|desconto|consegue fazer por/i.test(lower)) return "OBJECTION";
  if (/negociar|parcelar|condi[çc]ã/i.test(lower)) return "NEGOTIATION";
  if (/reunião|reuniao|agendar|call|horário|horario/i.test(lower)) return "SCHEDULING";
  if (/problema|erro|bug|não funciona/i.test(lower)) return "SUPPORT";
  if (/reclama|p[ée]ssimo|demora/i.test(lower)) return "COMPLAINT";
  if (/quero|preciso|interess/i.test(lower)) return "INTEREST";
  if (/^(oi|olá|ola|bom dia|boa tarde|boa noite|hey|hi)/i.test(lower) && lower.length <= 25) return "GREETING";
  if (/\?/.test(text)) return "QUESTION";
  return "UNKNOWN";
}
