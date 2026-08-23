import { DatabaseSync } from "node:sqlite";
import { NotFoundError } from "../errors/errors.ts";

export interface EntityRecord {
  id: string;
  canonicalName: string;
  type: string;
  status: string | null;
  aliases: string[];
  metadata: Record<string, unknown>;
  sourceId: string | null;
  originDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
}

interface RawEntityRow {
  id: string;
  canonical_name: string;
  type: string;
  status: string | null;
  aliases: string;
  metadata: string;
  source_id: string | null;
  origin_document_id: string | null;
  created_at: string;
  updated_at: string;
}

export function rowToEntity(row: RawEntityRow): EntityRecord {
  let aliases: unknown[] = [];
  let metadata: Record<string, unknown> = {};
  try {
    const parsedAliases: unknown = JSON.parse(row.aliases ?? "[]");
    if (Array.isArray(parsedAliases)) aliases = parsedAliases;
  } catch {}
  try {
    const parsedMeta: unknown = JSON.parse(row.metadata ?? "{}");
    if (parsedMeta && typeof parsedMeta === "object" && !Array.isArray(parsedMeta)) {
      metadata = parsedMeta as Record<string, unknown>;
    }
  } catch {}

  return {
    id: row.id,
    canonicalName: row.canonical_name,
    type: row.type,
    status: row.status,
    aliases: aliases.filter((a): a is string => typeof a === "string"),
    metadata,
    sourceId: row.source_id,
    originDocumentId: row.origin_document_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function selectEntitySql(): string {
  return `SELECT id, canonical_name, type, status, aliases, metadata,
             source_id, origin_document_id, created_at, updated_at
          FROM entities`;
}

export function getEntity(db: DatabaseSync, id: string): EntityRecord {
  const row = db.prepare(`${selectEntitySql()} WHERE id = ?`).get(id) as
    | RawEntityRow
    | undefined;
  if (!row) {
    throw new NotFoundError(`entity not found: ${id}`, { id });
  }
  return rowToEntity(row);
}

export function findEntityOptional(
  db: DatabaseSync,
  id: string,
): EntityRecord | undefined {
  const row = db.prepare(`${selectEntitySql()} WHERE id = ?`).get(id) as
    | RawEntityRow
    | undefined;
  return row ? rowToEntity(row) : undefined;
}

export function allEntities(db: DatabaseSync): EntityRecord[] {
  const rows = db.prepare(`${selectEntitySql()} ORDER BY id`).all() as unknown as RawEntityRow[];
  return rows.map(rowToEntity);
}

export interface EntityStats {
  outgoingRelations: number;
  incomingRelations: number;
  memories: number;
  originDocument?: {
    path: string;
    title: string | null;
    type: string | null;
    modifiedAt: string | null;
  };
}

export function getEntityStats(db: DatabaseSync, id: string): EntityStats {
  const out = db
    .prepare("SELECT COUNT(*) AS c FROM relations WHERE source_entity = ?")
    .get(id) as { c: number };
  const inc = db
    .prepare("SELECT COUNT(*) AS c FROM relations WHERE target_entity = ?")
    .get(id) as { c: number };
  const mem = db
    .prepare("SELECT COUNT(*) AS c FROM memories WHERE entity_id = ?")
    .get(id) as { c: number };

  const doc = db
    .prepare(
      `SELECT d.path AS path, d.title AS title, d.type AS type, d.modified_at AS modified_at
       FROM documents d
       JOIN entities e ON e.origin_document_id = d.id
       WHERE e.id = ?`,
    )
    .get(id) as
    | { path: string; title: string | null; type: string | null; modified_at: string | null }
    | undefined;

  return {
    outgoingRelations: out?.c ?? 0,
    incomingRelations: inc?.c ?? 0,
    memories: mem?.c ?? 0,
    originDocument: doc
      ? {
          path: doc.path,
          title: doc.title,
          type: doc.type,
          modifiedAt: doc.modified_at,
        }
      : undefined,
  };
}
