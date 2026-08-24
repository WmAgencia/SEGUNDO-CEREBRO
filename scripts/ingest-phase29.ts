import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { applySchema, openDatabase } from "../storage/connection.ts";
import { ingestSource, resolveEntityByName } from "../core/ingest/whatsapp-ingest.ts";
import type { BrainConfig } from "../core/config/loader.ts";
import { loadConfig } from "../core/config/loader.ts";

const config: BrainConfig = loadConfig();
const db = openDatabase(config.dbPath);
applySchema(db);

db.exec(`CREATE TABLE IF NOT EXISTS wa_contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id TEXT UNIQUE NOT NULL,
  name TEXT,
  phone TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);`);

const EXPORTS = path.join(config.dataDir, "..", "skills-sources", "whatsapp-exports");

const sources = [
  { sourceId: "ana", filePath: path.join(EXPORTS, "ana", "Conversa do WhatsApp com Ana.txt"), contextScope: "PERSONAL", contactName: "Ana", confidenceBase: 0.85 },
  { sourceId: "samira-a", filePath: path.join(EXPORTS, "samira-a", "Conversa do WhatsApp com +55 11 99767-3531.txt"), contextScope: "COMMERCIAL", contactPhone: "5511997673531", contactName: "Samira", confidenceBase: 0.95 },
  { sourceId: "derek", filePath: path.join(EXPORTS, "derek", "Conversa do WhatsApp com +55 11 96752-5155.txt"), contextScope: "FRIEND", contactPhone: "5511967525155", contactName: "Derek", confidenceBase: 0.85 },
  { sourceId: "samira-b", filePath: path.join(EXPORTS, "samira-b", "Conversa do WhatsApp com +55 11 94317-7406.txt"), contextScope: "COMMERCIAL", contactPhone: "5511943177406", contactName: "Samira", confidenceBase: 0.9 },
];

console.log("=== FASE 29 — INGEST ===");
for (const src of sources) {
  try {
    const result = ingestSource(db, src);
    console.log(`OK ${src.sourceId}: ${result.totalMessages} msgs -> ${result.stored} stored (${result.skipped} skipped)`);
  } catch (err) {
    console.error(`FAIL ${src.sourceId}: ${err instanceof Error ? err.message : err}`);
  }
}

const resolution = resolveEntityByName(db, "Samira");
if (resolution) {
  console.log(`ENTITY RESOLUTION Samira: phones=${resolution.phones.length} confidence=${resolution.confidence}`);
}

const total = db.prepare("SELECT COUNT(*) AS c FROM memories").get() as { c: number };
console.log(`Total memories: ${total.c}`);
db.close();
