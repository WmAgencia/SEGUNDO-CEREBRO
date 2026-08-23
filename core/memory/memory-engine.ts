import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";

const SOURCE_ID = "src.system";

export interface MemoryRecord {
  id: number;
  memoryKind: string;
  category: string | null;
  content: string;
  entityId: string | null;
  project: string | null;
  confidence: number;
  importance: number;
  accessCount: number;
  lastAccessedAt: string | null;
  createdAt: string;
}

export interface CreateMemoryInput {
  content: string;
  memoryKind?: string;
  category?: string;
  entityId?: string;
  projectId?: string;
  confidence?: number;
  importance?: number;
}

export interface MemorySearchFilters {
  text?: string;
  entityId?: string;
  project?: string;
  kind?: string;
  category?: string;
  minImportance?: number;
  from?: string;
  to?: string;
  limit?: number;
}

interface RawMemory {
  id: number;
  memory_kind: string;
  category: string | null;
  content: string;
  entity_id: string | null;
  project: string | null;
  confidence: number;
  importance: number;
  access_count: number;
  last_accessed_at: string | null;
  created_at: string;
}

function toMemory(r: RawMemory): MemoryRecord {
  return {
    id: r.id,
    memoryKind: r.memory_kind,
    category: r.category,
    content: r.content,
    entityId: r.entity_id,
    project: r.project,
    confidence: r.confidence,
    importance: r.importance,
    accessCount: r.access_count,
    lastAccessedAt: r.last_accessed_at,
    createdAt: r.created_at,
  };
}

export function computeImportance(input: {
  confidence?: number;
  explicit?: number;
  accessCount?: number;
  createdAt?: string;
  linkedToProject?: boolean;
}): number {
  const base = Math.max(input.explicit ?? 0, input.confidence ?? 0.5, 0.3);
  const accessBoost = Math.min(0.2, (input.accessCount ?? 0) * 0.04);
  let recency = 1;
  if (input.createdAt) {
    const days = (Date.now() - Date.parse(input.createdAt)) / 86400000;
    if (Number.isFinite(days) && days > 0) recency = Math.max(0.5, 1 - days / 365);
  }
  const projectBoost = input.linkedToProject ? 0.1 : 0;
  return Math.round(Math.min(1, base * recency + accessBoost + projectBoost) * 100) / 100;
}

export function createMemory(
  db: DatabaseSync,
  input: CreateMemoryInput,
): MemoryRecord {
  if (!input.content || input.content.trim() === "") {
    throw new ValidationError("memory content is empty");
  }
  const nowIso = new Date().toISOString();
  db.prepare(
    `INSERT INTO sources (id, source_type, location) VALUES ('src.system', 'system', 'memory-engine')
     ON CONFLICT(id) DO NOTHING`,
  ).run();
  const importance =
    input.importance ??
    computeImportance({
      confidence: input.confidence,
      linkedToProject: !!input.projectId,
    });

  const inserted = db
    .prepare(
      `INSERT INTO memories (memory_kind, category, content, entity_id, project, confidence, importance, source_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.memoryKind ?? "semantic",
      input.category ?? null,
      input.content.trim(),
      input.entityId ?? null,
      input.projectId ?? null,
      input.confidence ?? 0.8,
      importance,
      SOURCE_ID,
    );
  const id = Number(inserted.lastInsertRowid);

  db.prepare(
    "INSERT INTO memories_fts (memory_id, content, category) VALUES (?, ?, ?)",
  ).run(id, input.content.trim(), input.category ?? "");
  db.prepare(
    `INSERT INTO events (event_type, subject, payload)
     VALUES ('memory.created', ?, ?)`,
  ).run(input.entityId ?? "system", JSON.stringify({ memoryId: id }));

  return getMemory(db, id);
}

export function getMemory(db: DatabaseSync, id: number): MemoryRecord {
  const row = db
    .prepare("SELECT * FROM memories WHERE id = ?")
    .get(id) as RawMemory | undefined;
  if (!row) {
    throw new ValidationError(`memory not found: ${id}`);
  }
  db.prepare(
    `UPDATE memories SET access_count = access_count + 1,
     last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?`,
  ).run(id);
  return toMemory({ ...row });
}

export function searchMemories(
  db: DatabaseSync,
  filters: MemorySearchFilters = {},
): MemoryRecord[] {
  const where: string[] = ["1=1"];
  const values: Array<string | number> = [];

  if (filters.text && filters.text.trim() !== "") {
    const sanitized = filters.text
      .match(/[\p{L}\p{N}_]+/gu)
      ?.map((t) => `"${t}"*`)
      .join(" AND ");
    if (sanitized) {
      where.push(
        `id IN (SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ?)`,
      );
      values.push(sanitized);
    }
  }
  if (filters.entityId) {
    where.push("(entity_id = ? OR project = ?)");
    values.push(filters.entityId, filters.entityId);
  }
  if (filters.project) {
    where.push("project = ?");
    values.push(filters.project);
  }
  if (filters.kind) {
    where.push("memory_kind = ?");
    values.push(filters.kind);
  }
  if (filters.category) {
    where.push("category = ?");
    values.push(filters.category.toUpperCase());
  }
  if (typeof filters.minImportance === "number") {
    where.push("importance >= ?");
    values.push(filters.minImportance);
  }
  if (filters.from) {
    where.push("created_at >= ?");
    values.push(filters.from);
  }
  if (filters.to) {
    where.push("created_at <= ?");
    values.push(filters.to);
  }

  const limit = Math.max(1, Math.min(200, filters.limit ?? 20));
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE ${where.join(" AND ")}
       ORDER BY importance DESC, created_at DESC LIMIT ?`,
    )
    .all(...values, limit) as unknown as RawMemory[];
  return rows.map(toMemory);
}

export function relatedMemories(
  db: DatabaseSync,
  entityOrProject: string,
  limit = 10,
): MemoryRecord[] {
  return searchMemories(db, { entityId: entityOrProject, limit });
}

export function updateMemoryImportance(
  db: DatabaseSync,
  id: number,
  explicit: number,
): MemoryRecord | undefined {
  const row = db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as
    | RawMemory
    | undefined;
  if (!row) return undefined;
  const importance = computeImportance({
    explicit,
    confidence: row.confidence,
    accessCount: row.access_count,
    createdAt: row.created_at,
    linkedToProject: !!row.project,
  });
  db.prepare("UPDATE memories SET importance = ? WHERE id = ?").run(
    importance,
    id,
  );
  return getMemory(db, id);
}

export function setWorkingMemory(
  db: DatabaseSync,
  taskKey: string,
  data: Record<string, unknown>,
  ttlMinutes = 60,
): void {
  if (!taskKey.trim()) throw new ValidationError("task_key is required");
  const expires = new Date(Date.now() + ttlMinutes * 60000).toISOString();
  db.prepare("DELETE FROM working_memory WHERE task_key = ?").run(taskKey);
  db.prepare(
    "INSERT INTO working_memory (task_key, data, expires_at) VALUES (?, ?, ?)",
  ).run(taskKey, JSON.stringify(data), expires);
}

export function getWorkingMemory(
  db: DatabaseSync,
  taskKey: string,
): Record<string, unknown> | null {
  const row = db
    .prepare("SELECT data, expires_at FROM working_memory WHERE task_key = ?")
    .get(taskKey) as { data: string; expires_at: string | null } | undefined;
  if (!row) return null;
  if (row.expires_at && Date.parse(row.expires_at) < Date.now()) {
    db.prepare("DELETE FROM working_memory WHERE task_key = ?").run(taskKey);
    return null;
  }
  try {
    return JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function clearExpiredWorkingMemory(db: DatabaseSync): number {
  const result = db
    .prepare(
      "DELETE FROM working_memory WHERE expires_at IS NOT NULL AND expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')",
    )
    .run();
  return Number(result.changes);
}
