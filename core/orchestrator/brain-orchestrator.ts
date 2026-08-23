import { routeQuery } from "./router.ts";
import type { RoutePlan } from "./router.ts";
import { buildContext } from "../context/context-builder.ts";
import type { BrainContext } from "../context/context-builder.ts";
import { resolveEntity } from "../entities/resolver.ts";
import type { ResolveMethod } from "../entities/resolver.ts";
import { searchDocuments } from "../retrieval/searcher.ts";
import type { SearchHit } from "../retrieval/searcher.ts";
import { DatabaseSync } from "node:sqlite";

export interface AskOptions {
  dbPath: string;
  query: string;
  depth?: number;
  limit?: number;
  maxChars?: number;
}

export interface AskResponse {
  query: string;
  route: RoutePlan;
  resolution: { entityId: string; method: ResolveMethod; confidence: number } | null;
  context: BrainContext | null;
  searchHits: SearchHit[];
  warnings: string[];
  generatedAt: string;
}

function resolveMentionedEntity(
  db: DatabaseSync,
  query: string,
): AskResponse["resolution"] {
  try {
    const result = resolveEntity(db, query);
    if (result.best) {
      return {
        entityId: result.best.entity.id,
        method: result.best.method,
        confidence: result.best.confidence,
      };
    }
  } catch {}
  return null;
}

function dedupeHits(hits: SearchHit[]): SearchHit[] {
  const byId = new Map<string, SearchHit>();
  for (const hit of hits) {
    if (!byId.has(hit.documentId)) byId.set(hit.documentId, hit);
  }
  return [...byId.values()];
}

export function ask(options: AskOptions): AskResponse {
  const warnings: string[] = [];
  const route = routeQuery(options.query);

  let resolution: AskResponse["resolution"] = null;
  let context: BrainContext | null = null;
  let searchHits: SearchHit[] = [];

  try {
    const db = new DatabaseSync(options.dbPath);
    try {
      resolution = resolveMentionedEntity(db, options.query);
    } finally {
      db.close();
    }
  } catch (err) {
    warnings.push(
      `resolução de entidade falhou: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (route.useSearch) {
    try {
      const search = searchDocuments({
        dbPath: options.dbPath,
        query: options.query,
        limit: options.limit ?? 5,
        filters:
          route.typeFilters.length > 0 ? { type: route.typeFilters } : undefined,
      });
      searchHits = search.hits;
      if (search.strategy === "or" && search.total > 0) {
        warnings.push("nenhuma correspondência exata: resultados por termos individuais");
      }
    } catch (err) {
      warnings.push(
        `busca falhou: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  try {
    context = buildContext({
      dbPath: options.dbPath,
      subject: resolution?.entityId ?? options.query,
      task: undefined,
      depth: options.depth,
      maxChars: options.maxChars,
    });
  } catch (err) {
    warnings.push(
      `construção de contexto falhou: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return {
    query: options.query,
    route,
    resolution,
    context,
    searchHits: dedupeHits(searchHits),
    warnings: [
      ...warnings,
      ...(context?.warnings.filter((w) => !warnings.includes(w)) ?? []),
    ],
    generatedAt: new Date().toISOString(),
  };
}
