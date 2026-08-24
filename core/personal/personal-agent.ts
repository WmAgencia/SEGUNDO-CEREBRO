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
  sources: string[];
  recentEvents: string[];
  communicationStyle: { tone: string; formality: string; messageLength: string };
  confidence: number;
}

export interface PersonalLimits { maxMessages: number; maxRuntimeMs: number; minConfidence: number; }

export function isAna(phone: string): boolean { const normalized = phone.replace(/\D/g, ""); return normalized === ANA_PHONE || normalized === `55${ANA_PHONE}`; }

export function compilePersonalContext(db: DatabaseSync, phone = ANA_PHONE): PersonalContext | null {
  if (!isAna(phone)) return null;
  const contact = db.prepare("SELECT id, external_id FROM wa_contacts WHERE external_id=?").get(ANA_PHONE) as { id: number; external_id: string } | undefined;
  const conversation = contact ? db.prepare("SELECT id FROM wa_conversations WHERE contact_id=? ORDER BY id DESC LIMIT 1").get(contact.id) as { id: number } | undefined : undefined;
  const messages = conversation ? db.prepare("SELECT content FROM wa_messages WHERE conversation_id=? ORDER BY id DESC LIMIT 12").all(conversation.id) as unknown as Array<{ content: string }> : [];
  const memories = db.prepare("SELECT content, source_id FROM memories WHERE category=? AND source_id IS NOT NULL ORDER BY importance DESC, created_at DESC LIMIT 8").all(ANA_CONTEXT) as unknown as Array<{ content: string; source_id: string | null }>;
  const notes = db.prepare("SELECT id FROM documents WHERE (path LIKE '%Ana%' OR metadata LIKE '%person.ana%') AND metadata LIKE '%PERSONAL%' LIMIT 8").all() as unknown as Array<{ id: string }>;
  const profile = db.prepare("SELECT tone, formality, message_length FROM comm_profiles WHERE owner IN (?,?) AND context=? ORDER BY id DESC LIMIT 1").get("ana", ANA_PHONE, ANA_CONTEXT) as { tone: string; formality: string; message_length: string } | undefined;
  const recent = messages.map((m) => redactSecrets(m.content)).reverse();
  const facts = memories.map((m) => redactSecrets(m.content));
  const sources = [...new Set([...memories.map((m) => m.source_id).filter((s): s is string => Boolean(s)), ...notes.map((n) => n.id)])];
  return { conversationId: conversation?.id ?? null, personId: "person.ana", lastMessage: recent.at(-1) ?? null, currentTopics: extractTopics(recent), openThreads: [], knownFacts: facts, sources, recentEvents: recent.slice(-4), communicationStyle: profile ? { tone: profile.tone, formality: profile.formality, messageLength: profile.message_length } : defaultStyle(), confidence: recent.length || facts.length || notes.length ? 0.75 : 0.35 };
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
