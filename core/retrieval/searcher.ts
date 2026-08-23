import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";
import { sanitizeFtsQuery } from "./fts-query.ts";

export interface SearchFilters {
  type?: string[];
  tag?: string;
  pathPrefix?: string;
  entityId?: string;
}

export interface SearchParams {
  dbPath: string;
  query: string;
  limit?: number;
  offset?: number;
  filters?: SearchFilters;
}

export interface SearchHit {
  documentId: string;
  path: string;
  title: string;
  type: string | null;
  score: number;
  snippet: string;
  tags: string[];
  entities: Array<{ id: string; name: string }>;
  sourceType: string;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  queryUsed: string;
  strategy: "and" | "or";
  tokens: string[];
}

interface RawRow {
  doc_id: string;
  path: string;
  title: string | null;
  type: string | null;
  metadata: string;
  score: number;
  snip: string | null;
}

function parseTags(metadataJson: string): string[] {
  try {
    const parsed = JSON.parse(metadataJson) as { tags?: unknown };
    if (Array.isArray(parsed.tags)) {
      return parsed.tags.filter((t): t is string => typeof t === "string");
    }
  } catch {}
  return [];
}

type SqlValue = string | number | bigint | Buffer | null;

function runSearch(
  db: DatabaseSync,
  matchExpression: string,
  params: SearchParams & { limit: number; offset: number },
  countOnly: boolean,
): { rows: RawRow[]; total: number } {
  const filters = params.filters ?? {};

  const filterParts: string[] = [];
  const filterValues: SqlValue[] = [];

  if (filters.type && filters.type.length > 0) {
    filterParts.push(`d.type IN (${filters.type.map(() => "?").join(",")})`);
    filterValues.push(...filters.type);
  }

  if (filters.tag) {
    filterParts.push(
      `d.id IN (
         SELECT doc_id FROM documents_fts
         WHERE documents_fts MATCH ?
       )`,
    );
    filterValues.push(`tags:"${filters.tag.replace(/"/g, "")}"`);
  }

  if (filters.pathPrefix) {
    filterParts.push(`d.path LIKE ? ESCAPE '\\'`);
    filterValues.push(
      filters.pathPrefix.replace(/[\\%_]/g, (m) => `\\${m}`) + "%",
    );
  }

  if (filters.entityId) {
    filterParts.push(
      "d.id IN (SELECT origin_document_id FROM entities WHERE id = ?)",
    );
    filterValues.push(filters.entityId);
  }

  const docIdsSubquery =
    "d.id IN (SELECT doc_id FROM documents_fts WHERE documents_fts MATCH ?)";

  const countWhereSql = [docIdsSubquery, ...filterParts].join(" AND ");
  const countValues: SqlValue[] = [matchExpression, ...filterValues];

  const rowsWhereSql = [
    docIdsSubquery,
    ...filterParts,
    "documents_fts MATCH ?",
  ].join(" AND ");
  const rowsValues: SqlValue[] = [
    matchExpression,
    ...filterValues,
    matchExpression,
  ];

  const totalRow = db
    .prepare(`SELECT COUNT(*) AS c FROM documents d WHERE ${countWhereSql}`)
    .get(...countValues) as { c: number };
  const total = totalRow?.c ?? 0;

  if (countOnly || total === 0) {
    return { rows: [], total };
  }

  const rows = db
    .prepare(
      `SELECT f.doc_id AS doc_id,
              d.path AS path,
              d.title AS title,
              d.type AS type,
              d.metadata AS metadata,
              bm25(documents_fts) AS score,
              snippet(documents_fts, 2, '[', ']', '…', 16) AS snip
       FROM documents_fts f
       JOIN documents d ON d.id = f.doc_id
       WHERE ${rowsWhereSql}
       ORDER BY score ASC, d.modified_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...rowsValues, params.limit, params.offset) as unknown as RawRow[];

  return { rows, total };
}

function attachEntities(db: DatabaseSync, hits: SearchHit[]): void {
  for (const hit of hits) {
    hit.entities = [];
  }
  const ids = hits.map((h) => h.documentId);
  if (ids.length === 0) return;

  const placeholders = ids.map(() => "?").join(",");
  const entityRows = db
    .prepare(
      `SELECT id, canonical_name, origin_document_id
       FROM entities
       WHERE origin_document_id IN (${placeholders})`,
    )
    .all(...ids) as unknown as Array<{
    id: string;
    canonical_name: string;
    origin_document_id: string;
  }>;

  for (const row of entityRows) {
    const hit = hits.find((h) => h.documentId === row.origin_document_id);
    if (hit) {
      hit.entities.push({ id: row.id, name: row.canonical_name });
    }
  }
}

export function searchDocuments(params: SearchParams): SearchResult {
  if (!params.dbPath) {
    throw new ValidationError("dbPath is required for search");
  }
  const sanitized = sanitizeFtsQuery(params.query);
  const limit = Math.max(1, params.limit ?? 10);
  const offset = Math.max(0, params.offset ?? 0);

  const effectiveParams = { ...params, limit, offset };

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(params.dbPath);
  } catch (err) {
    throw new ValidationError("database not available for search", {
      cause: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    let strategy: "and" | "or" = "and";
    let { rows, total } = runSearch(db, sanitized.andQuery, effectiveParams, false);

    if (total === 0 && sanitized.tokens.length > 1) {
      strategy = "or";
      ({ rows, total } = runSearch(db, sanitized.orQuery, effectiveParams, false));
    }

    const hits: SearchHit[] = rows.map((row) => ({
      documentId: row.doc_id,
      path: row.path,
      title: row.title ?? row.path,
      type: row.type,
      score: Number(row.score),
      snippet: row.snip ?? "",
      tags: parseTags(row.metadata),
      entities: [],
      sourceType: "obsidian",
    }));

    attachEntities(db, hits);

    return {
      hits,
      total,
      queryUsed: strategy === "and" ? sanitized.andQuery : sanitized.orQuery,
      strategy,
      tokens: sanitized.tokens,
    };
  } finally {
    db.close();
  }
}
