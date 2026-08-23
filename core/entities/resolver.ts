import type { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";
import { sanitizeFtsQuery } from "../retrieval/fts-query.ts";
import {
  allEntities,
  findEntityOptional,
  rowToEntity,
} from "./entity.ts";
import type { EntityRecord } from "./entity.ts";

export type ResolveMethod = "id" | "alias" | "name" | "prefix" | "fts";

export interface ResolvedCandidate {
  entity: EntityRecord;
  method: ResolveMethod;
  confidence: number;
}

export interface ResolveResult {
  query: string;
  best: ResolvedCandidate | null;
  candidates: ResolvedCandidate[];
}

interface AliasIndex {
  byAlias: Map<string, EntityRecord[]>;
  byName: Map<string, EntityRecord[]>;
  all: EntityRecord[];
}

function buildAliasIndex(db: DatabaseSync): AliasIndex {
  const entities = allEntities(db);
  const index: AliasIndex = { byAlias: new Map(), byName: new Map(), all: entities };
  for (const entity of entities) {
    const nameKey = entity.canonicalName.toLowerCase();
    const nameList = index.byName.get(nameKey) ?? [];
    nameList.push(entity);
    index.byName.set(nameKey, nameList);

    for (const alias of entity.aliases) {
      const key = alias.toLowerCase();
      const list = index.byAlias.get(key) ?? [];
      list.push(entity);
      index.byAlias.set(key, list);
    }
  }
  return index;
}

function resolveByFts(
  db: DatabaseSync,
  query: string,
): ResolvedCandidate | null {
  let matchExpression: string;
  try {
    matchExpression = sanitizeFtsQuery(query).orQuery;
  } catch {
    return null;
  }

  const rows = db
    .prepare(
      `SELECT e.id, e.canonical_name, e.type, e.status, e.aliases, e.metadata,
              e.source_id, e.origin_document_id, e.created_at, e.updated_at
       FROM documents_fts fts
       JOIN documents d ON d.id = fts.doc_id
       JOIN entities e ON e.origin_document_id = d.id
       WHERE documents_fts MATCH ?
       ORDER BY bm25(documents_fts) ASC
       LIMIT 1`,
    )
    .all(matchExpression) as unknown as Array<Parameters<typeof rowToEntity>[0]>;

  const first = rows[0];
  if (!first) return null;
  return { entity: rowToEntity(first), method: "fts", confidence: 0.5 };
}

export function resolveEntity(
  db: DatabaseSync,
  query: string,
): ResolveResult {
  if (typeof query !== "string" || query.trim() === "") {
    throw new ValidationError("resolve query is empty");
  }
  const trimmed = query.trim();

  const exact = findEntityOptional(db, trimmed);
  if (exact) {
    return {
      query: trimmed,
      best: { entity: exact, method: "id", confidence: 1 },
      candidates: [{ entity: exact, method: "id", confidence: 1 }],
    };
  }

  const index = buildAliasIndex(db);
  const lower = trimmed.toLowerCase();
  const candidates: ResolvedCandidate[] = [];

  for (const entity of index.byAlias.get(lower) ?? []) {
    candidates.push({ entity, method: "alias", confidence: 0.9 });
  }
  if (candidates.length === 0) {
    for (const entity of index.byName.get(lower) ?? []) {
      candidates.push({ entity, method: "name", confidence: 0.85 });
    }
  }

  if (candidates.length === 0 && trimmed.length >= 3) {
    const prefixMatches = index.all
      .filter((e) => e.canonicalName.toLowerCase().startsWith(lower))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (prefixMatches.length === 1) {
      const single = prefixMatches[0];
      if (single) {
        candidates.push({ entity: single, method: "prefix", confidence: 0.7 });
      }
    } else {
      for (const entity of prefixMatches) {
        candidates.push({ entity, method: "prefix", confidence: 0.6 });
      }
    }
  }

  if (candidates.length === 0) {
    const ftsHit = resolveByFts(db, trimmed);
    if (ftsHit) candidates.push(ftsHit);
  }

  const best =
    candidates.length > 0
      ? candidates.reduce((a, b) => (b.confidence > a.confidence ? b : a))
      : null;

  return { query: trimmed, best, candidates };
}
