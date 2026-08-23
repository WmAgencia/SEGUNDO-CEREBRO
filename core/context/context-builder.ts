import { DatabaseSync } from "node:sqlite";
import { getEntity, getEntityStats } from "../entities/entity.ts";
import type { EntityRecord } from "../entities/entity.ts";
import { resolveEntity } from "../entities/resolver.ts";
import type { ResolveMethod } from "../entities/resolver.ts";
import { relatedEdges } from "../relations/graph.ts";
import type { GraphEdge } from "../relations/graph.ts";
import { searchDocuments } from "../retrieval/searcher.ts";
import type { SearchHit } from "../retrieval/searcher.ts";
import { buildTimeline } from "../retrieval/timeline.ts";
import { ValidationError } from "../errors/errors.ts";

export interface RelatedEntityInfo {
  id: string;
  name: string;
  type: string;
  relation: string;
  direction: "out" | "in" | "both";
}

export interface DocumentRef {
  path: string;
  title: string;
  type: string | null;
  score?: number;
}

export interface BrainContext {
  subject: string;
  entityId: string | null;
  resolvedBy: ResolveMethod | null;
  entityType: string | null;
  status: string | null;
  summary: string | null;
  aliases: string[];
  relatedEntities: RelatedEntityInfo[];
  decisions: Array<{ id: string; title: string; status: string | null }>;
  procedures: Array<{ id: string; title: string; status: string | null }>;
  recentEvents: TimelineEntryLite[];
  documents: DocumentRef[];
  sources: Array<{ sourceType: string; location: string }>;
  warnings: string[];
  truncated: boolean;
  charBudget: { used: number; max: number };
  generatedAt: string;
}

export interface TimelineEntryLite {
  at: string;
  kind: string;
  summary: string;
}

export interface BuildContextOptions {
  dbPath: string;
  subject: string;
  task?: string;
  depth?: number;
  maxChars?: number;
}

class Budget {
  used = 0;
  private budgetMax: number;

  constructor(budgetMax: number) {
    this.budgetMax = budgetMax;
  }

  get max(): number {
    return this.budgetMax;
  }
  canFit(size: number): boolean {
    return this.used + size <= this.budgetMax;
  }
  spend(size: number): void {
    this.used += size;
  }
}

function estimate(value: unknown): number {
  return JSON.stringify(value)?.length ?? 0;
}

function firstParagraph(db: DatabaseSync, originDocId: string | null): string | null {
  if (!originDocId) return null;
  const row = db
    .prepare(
      `SELECT content FROM chunks
       WHERE document_id = ? AND ordinal = 0`,
    )
    .get(originDocId) as { content: string } | undefined;
  if (!row?.content) return null;

  const withoutHeadings = row.content
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join(" ")
    .trim();
  const flat = withoutHeadings.replace(/\s+/g, " ");
  if (flat === "") return null;
  return flat.length > 400 ? `${flat.slice(0, 397).trimEnd()}…` : flat;
}

function collectRelated(
  edges: GraphEdge[],
  entityLookup: Map<string, EntityRecord>,
  subjectId: string,
): RelatedEntityInfo[] {
  const seen = new Set<string>();
  const out: RelatedEntityInfo[] = [];
  for (const edge of edges) {
    const isOut = edge.source === subjectId;
    const otherId = isOut ? edge.target : edge.source;
    if (otherId === subjectId || seen.has(otherId)) continue;
    const entity = entityLookup.get(otherId);
    seen.add(otherId);
    out.push({
      id: otherId,
      name: entity?.canonicalName ?? otherId,
      type: entity?.type ?? "unknown",
      relation: edge.relationType,
      direction: isOut ? "out" : "in",
    });
  }
  return out;
}

function docsForSearchHit(hit: SearchHit): DocumentRef {
  return {
    path: hit.path,
    title: hit.title,
    type: hit.type,
    score: Number.isFinite(hit.score) ? hit.score : undefined,
  };
}

function dedupeDocuments(docs: DocumentRef[]): DocumentRef[] {
  const byPath = new Map<string, DocumentRef>();
  for (const doc of docs) {
    if (!byPath.has(doc.path)) byPath.set(doc.path, doc);
  }
  return [...byPath.values()];
}

const SECTION_ORDER = [
  "entity",
  "summary",
  "related",
  "decisions",
  "procedures",
  "documents",
  "events",
] as const;

export function buildContext(options: BuildContextOptions): BrainContext {
  const { dbPath, subject } = options;
  if (!subject || subject.trim() === "") {
    throw new ValidationError("context subject is empty");
  }

  const maxChars = Math.max(1, options.maxChars ?? 12000);
  const depth = Math.max(1, Math.min(5, options.depth ?? 1));
  const warnings: string[] = [];
  let truncated = false;

  const db = new DatabaseSync(dbPath);
  let entity: EntityRecord | null = null;
  let resolvedBy: ResolveMethod | null = null;

  try {
    const resolution = resolveEntity(db, subject);
    if (resolution.best) {
      entity = resolution.best.entity;
      resolvedBy = resolution.best.method;
    } else {
      warnings.push(`subject "${subject}" não resolveu para nenhuma entidade`);
    }

    let relatedEntities: RelatedEntityInfo[] = [];
    let decisions: BrainContext["decisions"] = [];
    let procedures: BrainContext["procedures"] = [];
    let recentEvents: TimelineEntryLite[] = [];
    let summary: string | null = null;
    let documents: DocumentRef[] = [];
    const sources: BrainContext["sources"] = [];

    if (entity) {
      const stats = getEntityStats(db, entity.id);
      summary = firstParagraph(db, entity.originDocumentId);

      const edges = relatedEdges(db, entity.id, { direction: "both" });
      const lookup = new Map<string, EntityRecord>();
      for (const edge of edges) {
        for (const id of [edge.source, edge.target]) {
          if (id !== entity.id && !lookup.has(id)) {
            try {
              lookup.set(id, getEntity(db, id));
            } catch {
              lookup.set(id, {
                id,
                canonicalName: id,
                type: "unknown",
                status: null,
                aliases: [],
                metadata: {},
                sourceId: null,
                originDocumentId: null,
                createdAt: "",
                updatedAt: "",
              });
            }
          }
        }
      }
      relatedEntities = collectRelated(edges, lookup, entity.id);

      for (const rel of relatedEntities) {
        const rec = lookup.get(rel.id);
        if (!rec) continue;
        if (rec.type === "decision") {
          decisions.push({ id: rec.id, title: rec.canonicalName, status: rec.status });
        } else if (rec.type === "procedure") {
          procedures.push({ id: rec.id, title: rec.canonicalName, status: rec.status });
        }
      }

      const timeline = buildTimeline(db, {
        entityId: entity.id,
        limit: 12,
        kinds: ["event", "document"],
      });
      recentEvents = timeline.map((t) => ({ at: t.at, kind: t.kind, summary: t.summary }));

      if (stats.originDocument) {
        sources.push({ sourceType: "obsidian", location: stats.originDocument.path });
      }
    }

    try {
      const searchQuery = options.task ? `${subject} ${options.task}` : subject;
      const search = searchDocuments({
        dbPath,
        query: searchQuery,
        limit: 5,
        filters: entity ? { entityId: entity.id } : undefined,
      });
      documents = dedupeDocuments(search.hits.map(docsForSearchHit));
      if (!entity && search.hits[0]) {
        sources.push({ sourceType: "obsidian", location: search.hits[0].path });
      }
    } catch {
      warnings.push("busca de documentos falhou");
    }

    const makeDraft = (
      over: Partial<
        Pick<
          BrainContext,
          | "relatedEntities"
          | "decisions"
          | "procedures"
          | "documents"
          | "recentEvents"
        >
      >,
    ): BrainContext => ({
      subject,
      entityId: entity?.id ?? null,
      resolvedBy,
      entityType: entity?.type ?? null,
      status: entity?.status ?? null,
      summary,
      aliases: entity?.aliases ?? [],
      relatedEntities: [],
      decisions: [],
      procedures: [],
      recentEvents: [],
      documents: [],
      sources,
      warnings,
      truncated: false,
      charBudget: { used: 0, max: maxChars },
      generatedAt: "",
      ...over,
    });

    const baseDraft = makeDraft({});
    let baseSize = estimate(baseDraft);

    while (baseSize > maxChars && summary !== null && summary.length > 0) {
      const nextLen = Math.floor(summary.length / 2);
      summary = nextLen < 20 ? null : `${summary.slice(0, nextLen).trimEnd()}…`;
      baseDraft.summary = summary;
      baseSize = estimate(baseDraft);
      truncated = true;
    }

    if (baseSize > maxChars) {
      truncated = true;
    }

    function fitList<K extends keyof BrainContext>(
      key: K,
      items: BrainContext[K],
    ): BrainContext[K] {
      type Item = BrainContext[K] extends Array<infer T> ? T : never;
      const kept: Item[] = [];
      for (const item of items as unknown as Item[]) {
        const draft = makeDraft({ [key]: [...kept, item] } as unknown as Partial<BrainContext>);
        if (estimate(draft) <= maxChars) {
          kept.push(item);
        } else {
          truncated = true;
        }
      }
      return kept as unknown as BrainContext[K];
    }

    relatedEntities = fitList("relatedEntities", relatedEntities);
    decisions = fitList("decisions", decisions);
    procedures = fitList("procedures", procedures);
    documents = fitList("documents", documents);
    recentEvents = fitList("recentEvents", recentEvents);

    if (truncated) {
      warnings.push("contexto truncado para caber no orçamento de caracteres");
    }

    const finalContext = makeDraft({
      relatedEntities,
      decisions,
      procedures,
      documents,
      recentEvents,
    });
    finalContext.warnings = warnings;
    finalContext.truncated = truncated;

    const {
      warnings: _w,
      generatedAt: _g,
      ...contentOnly
    } = finalContext;
    void _w;
    void _g;
    finalContext.charBudget.used = estimate(contentOnly);

    return finalContext;
  } finally {
    db.close();
  }
}
