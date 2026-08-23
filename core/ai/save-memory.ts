import { DatabaseSync } from "node:sqlite";
import type { MemoryCategory } from "./memory-extractor.ts";
import type { BrainConfig } from "../config/loader.ts";
import { resolveEntity } from "../entities/resolver.ts";

const SOURCE_ID = "src.conversation";

export interface SaveMemoryInput {
  content: string;
  category?: string;
  memoryKind?: "episodic" | "semantic" | "procedural" | "decision" | "relational";
  entityId?: string;
  confidence?: number;
}

function ensureConversationSource(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO sources (id, source_type, location) VALUES (?, 'conversation', 'cli')
     ON CONFLICT(id) DO NOTHING`,
  ).run(SOURCE_ID);
}

function resolveEntityId(
  db: DatabaseSync,
  query: string,
): string | undefined {
  try {
    const result = resolveEntity(db, query);
    return result.best?.entity.id;
  } catch {
    return undefined;
  }
}

export function saveConfirmedMemory(
  config: BrainConfig,
  input: SaveMemoryInput,
): { ok: true; memoryId: number; entityId: string | null } {
  const db = new DatabaseSync(config.dbPath);
  try {
    db.exec("BEGIN");
    ensureConversationSource(db);

    let entityId: string | null = null;
    if (input.entityId && input.entityId.trim() !== "") {
      entityId = resolveEntityId(db, input.entityId) ?? null;
    }

    const kind = input.memoryKind ?? "semantic";
    const inserted = db
      .prepare(
        `INSERT INTO memories (memory_kind, category, content, entity_id, confidence, source_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        kind,
        input.category ?? null,
        input.content.trim(),
        entityId,
        input.confidence ?? 0.8,
        SOURCE_ID,
      );
    const memoryId = Number(inserted.lastInsertRowid);

    db.prepare(
      `INSERT INTO events (event_type, subject, payload)
       VALUES ('memory.created', ?, ?)`,
    ).run(entityId ?? "conversation", JSON.stringify({ memoryId }));

    db.exec("COMMIT");
    return { ok: true, memoryId, entityId };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    db.close();
  }
}
