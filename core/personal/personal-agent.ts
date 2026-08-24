import { DatabaseSync } from "node:sqlite";
import { redactSecrets } from "../exec/redact.ts";

export const ANA_PHONE = "15981142057";
const ANA_CONTEXT = "PERSONAL";

export interface PersonalContext {
  conversationId: number | null;
  personId: string;
  lastMessage: string | null;
  currentTopics: string[];
  openThreads: string[];
  knownFacts: string[];
  recentEvents: string[];
  communicationStyle: { tone: string; formality: string; messageLength: string };
  confidence: number;
}

export interface PersonalLimits { maxMessages: number; maxRuntimeMs: number; minConfidence: number; }

export function isAna(phone: string): boolean { const normalized = phone.replace(/\D/g, ""); return normalized === ANA_PHONE || normalized === `55${ANA_PHONE}`; }

export function compilePersonalContext(db: DatabaseSync, phone = ANA_PHONE): PersonalContext | null {
  if (!isAna(phone)) return null;
  const contact = db.prepare("SELECT id, external_id FROM wa_contacts WHERE external_id=?").get(ANA_PHONE) as { id: number; external_id: string } | undefined;
  if (!contact) return { conversationId: null, personId: `person.${ANA_PHONE}`, lastMessage: null, currentTopics: [], openThreads: [], knownFacts: [], recentEvents: [], communicationStyle: defaultStyle(), confidence: 0 };
  const conversation = db.prepare("SELECT id FROM wa_conversations WHERE contact_id=? ORDER BY id DESC LIMIT 1").get(contact.id) as { id: number } | undefined;
  const messages = conversation ? db.prepare("SELECT content FROM wa_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 12").all(conversation.id) as unknown as Array<{ content: string }> : [];
  const memories = db.prepare("SELECT content FROM memories WHERE category=? AND (content LIKE ? OR content LIKE ?) ORDER BY importance DESC, created_at DESC LIMIT 8").all(ANA_CONTEXT, "%Ana%", `%${ANA_PHONE}%`) as unknown as Array<{ content: string }>;
  const profile = db.prepare("SELECT tone, formality, message_length FROM comm_profiles WHERE owner IN (?,?) AND context=? ORDER BY id DESC LIMIT 1").get("ana", ANA_PHONE, ANA_CONTEXT) as { tone: string; formality: string; message_length: string } | undefined;
  const recent = messages.map((m) => redactSecrets(m.content)).reverse();
  const facts = memories.map((m) => redactSecrets(m.content));
  return { conversationId: conversation?.id ?? null, personId: `person.${ANA_PHONE}`, lastMessage: recent.at(-1) ?? null, currentTopics: extractTopics(recent), openThreads: [], knownFacts: facts, recentEvents: recent.slice(-4), communicationStyle: profile ? { tone: profile.tone, formality: profile.formality, messageLength: profile.message_length } : defaultStyle(), confidence: contact && (recent.length || facts.length) ? 0.75 : 0.35 };
}

export function qualityGate(context: PersonalContext | null, reply: string, limits: PersonalLimits = { maxMessages: 20, maxRuntimeMs: 30 * 60_000, minConfidence: 0.55 }): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!context || context.confidence < limits.minConfidence) reasons.push("personal context confidence below threshold");
  if (/(consecom|vyntra|nutriva|cliente|lead|marketing|vendas|sales)/i.test(reply)) reasons.push("commercial context detected");
  if (/(api[_-]?key|token|password|secret|bearer)/i.test(reply)) reasons.push("secret-like content detected");
  return { allowed: reasons.length === 0, reasons };
}

export function personalReply(context: PersonalContext, inbound: string): { text: string; confidence: number } {
  const text = context.lastMessage ? "Entendi. Me conta mais sobre isso, quero acompanhar." : "Oi, Ana. Como você está?";
  return { text: inbound.trim() ? text : "Oi, Ana.", confidence: context.confidence };
}

function defaultStyle(): PersonalContext["communicationStyle"] { return { tone: "natural", formality: "informal", messageLength: "curta" }; }
function extractTopics(messages: string[]): string[] { return [...new Set(messages.flatMap((m) => (m.toLowerCase().match(/[\p{L}]{5,}/gu) ?? []).slice(0, 3)))].slice(0, 8); }
