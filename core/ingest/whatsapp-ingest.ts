import { DatabaseSync } from "node:sqlite";
import { readFileSync, existsSync } from "node:fs";

export interface SourceConfig {
  sourceId: string;
  filePath: string;
  contextScope: string;
  contactPhone?: string;
  contactName?: string;
  confidenceBase: number;
}

export interface ParsedMessage {
  timestamp: string;
  speaker: string;
  content: string;
  isSystem: boolean;
}

const MSG_RE = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2})(?:\s*-\s*)(.*?)(?::\s)(.*)$/;

export function parseWhatsAppExport(filePath: string): ParsedMessage[] {
  if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
  const raw = readFileSync(filePath, "latin1");
  const lines = raw.split(/\r?\n/);
  const messages: ParsedMessage[] = [];

  for (const line of lines) {
    const match = MSG_RE.exec(line);
    if (!match) {
      if (messages.length > 0 && line.trim()) {
        const last = messages[messages.length - 1];
        if (last) last.content += `\n${line}`;
      }
      continue;
    }
    const date = match[1] ?? "";
    const time = match[2] ?? "";
    const speaker = match[3] ?? "";
    const content = match[4] ?? "";
    const parts = date.split("/");
    const y = parts[2] ?? "2026";
    const m = parts[1] ?? "01";
    const d = parts[0] ?? "01";
    const iso = `${y}-${m}-${d}T${time}:00`;
    const isSystem = /criptografia|bloqueou|desbloqueou/i.test(content);
    messages.push({
      timestamp: iso,
      speaker: speaker.trim(),
      content: content.trim(),
      isSystem,
    });
  }
  return messages.filter((m) => !m.isSystem && m.content.length > 0);
}

export interface IngestResult {
  sourceId: string;
  totalMessages: number;
  stored: number;
  skipped: number;
  contactsCreated: number;
}

export function ingestSource(
  db: DatabaseSync,
  cfg: SourceConfig,
): IngestResult {
  const messages = parseWhatsAppExport(cfg.filePath);
  let stored = 0;
  let skipped = 0;
  const knownPhones = new Set<string>();

  db.prepare(
    `INSERT INTO skill_sources (id, kind, url, last_indexed_at)
     VALUES (?, 'whatsapp_export', ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(id) DO UPDATE SET last_indexed_at = excluded.last_indexed_at`,
  ).run(cfg.sourceId, cfg.contactPhone ?? null);

  db.prepare(
    `INSERT INTO sources (id, source_type, location) VALUES (?, 'whatsapp_export', ?)
     ON CONFLICT(id) DO NOTHING`,
  ).run(`src.${cfg.sourceId}`, cfg.filePath);

  for (const msg of messages) {
    const isOwner = /wesley|consecom/i.test(msg.speaker);
    const speakerKey = isOwner ? "owner" : cfg.sourceId;

    if (!knownPhones.has(speakerKey)) {
      knownPhones.add(speakerKey);
      db.prepare(
        `INSERT INTO wa_contacts (external_id, name, metadata) VALUES (?, ?, ?)
         ON CONFLICT(external_id) DO NOTHING`,
      ).run(
        speakerKey === "owner" ? "5515981732994" : cfg.contactPhone ?? speakerKey,
        isOwner ? "Wesley (Consecom)" : cfg.contactName ?? msg.speaker,
        JSON.stringify({ sourceId: cfg.sourceId, contextScope: cfg.contextScope }),
      );
    }

    if (msg.content.length < 3) { skipped++; continue; }

    const confidence = Math.min(1, cfg.confidenceBase + (msg.content.length > 50 ? 0.05 : 0));

    try {
      db.prepare(
        `INSERT INTO memories (memory_kind, category, content, entity_id, project,
           confidence, importance, source_id, created_at)
         VALUES ('episodic', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        cfg.contextScope.toUpperCase(),
        redactContent(msg.content),
        null,
        "consecom",
        confidence,
        Math.min(0.9, confidence * 0.8),
        `src.${cfg.sourceId}`,
        msg.timestamp,
      );
      stored++;

      const memId = Number(
        (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
      );
      db.prepare(
        "INSERT INTO memories_fts (memory_id, content, category) VALUES (?, ?, ?)",
      ).run(memId, msg.content.slice(0, 500), cfg.contextScope);
    } catch {
      skipped++;
    }
  }

  return {
    sourceId: cfg.sourceId,
    totalMessages: messages.length,
    stored,
    skipped,
    contactsCreated: knownContacts(db, cfg.sourceId),
  };
}

function knownContacts(db: DatabaseSync, sourceId: string): number {
  return Number(
    (db.prepare("SELECT COUNT(*) AS c FROM wa_contacts WHERE external_id LIKE ?").get(`%${sourceId}%`) as { c: number }).c,
  );
}

function redactContent(text: string): string {
  return text
    .replace(/(?:gsk_|sk-)[A-Za-z0-9]{10,}/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

export interface EntityResolution {
  canonicalName: string;
  phones: string[];
  sources: string[];
  confidence: number;
  evidenceCount: number;
}

export function resolveEntityByName(
  db: DatabaseSync,
  name: string,
): EntityResolution | null {
  const lower = name.toLowerCase();
  const rows = db
    .prepare("SELECT id, external_id, metadata FROM wa_contacts WHERE LOWER(name) LIKE ?")
    .all(`%${lower}%`) as unknown as Array<{
    id: number; external_id: string; metadata: string;
  }>;

  if (rows.length < 2) {
    const single = rows[0];
    return single
      ? { canonicalName: name, phones: [single.external_id], sources: [], confidence: 0.6, evidenceCount: 1 }
      : null;
  }

  const phones = rows.map((r) => r.external_id);
  const sources = new Set<string>();
  for (const r of rows) {
    try {
      const meta = JSON.parse(r.metadata ?? "{}");
      if (meta.sourceId) sources.add(meta.sourceId);
    } catch {}
  }
  return {
    canonicalName: name,
    phones,
    sources: [...sources],
    confidence: Math.min(0.95, 0.7 + rows.length * 0.08),
    evidenceCount: rows.length,
  };
}
