import { DatabaseSync } from "node:sqlite";

export function ensureCommTables(db: DatabaseSync): void {
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
