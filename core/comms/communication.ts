import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";

export type CommContext = "COMMERCIAL" | "PROFESSIONAL" | "CUSTOMER_SUPPORT" | "NEGOTIATION" | "INTERNAL" | "PERSONAL";

export interface CommProfile {
  id: number;
  owner: string;
  context: string;
  tone: string;
  formality: string;
  messageLength: string;
}

export function saveProfile(
  db: DatabaseSync,
  input: { owner: string; context: CommContext; tone: string; formality: string; messageLength?: string },
): void {
  if (!input.owner || !input.tone) throw new ValidationError("owner e tone são obrigatórios");
  db.prepare(
    `INSERT INTO comm_profiles (owner, context, tone, formality, message_length)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner, context) DO UPDATE SET tone=excluded.tone, formality=excluded.formality, message_length=excluded.message_length`,
  ).run(input.owner, input.context, input.tone, input.formality ?? "formal", input.messageLength ?? "curta");
}

export function getProfile(db: DatabaseSync, owner: string, context: CommContext): CommProfile | undefined {
  const row = db
    .prepare("SELECT * FROM comm_profiles WHERE owner = ? AND context = ?")
    .get(owner, context) as Record<string, unknown> | undefined;
  if (!row) return undefined;
  return {
    id: Number(row.id),
    owner: String(row.owner),
    context: String(row.context),
    tone: String(row.tone),
    formality: String(row.formality),
    messageLength: String(row.message_length ?? "curta"),
  };
}
