import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";
import { loadConfig } from "../../core/config/loader.ts";
import type { BrainConfig } from "../../core/config/loader.ts";
import { getEntity } from "../../core/entities/entity.ts";
import { resolveEntity } from "../../core/entities/resolver.ts";
import { relatedEdges } from "../../core/relations/graph.ts";
import { searchDocuments } from "../../core/retrieval/searcher.ts";
import { buildTimeline } from "../../core/retrieval/timeline.ts";
import { buildContext } from "../../core/context/context-builder.ts";
import { applySchema } from "../../storage/connection.ts";
import { NotFoundError, ValidationError } from "../../core/errors/errors.ts";

const CONVERSATION_SOURCE_ID = "src.conversation";
const MEMORY_KINDS = ["episodic", "semantic", "procedural", "decision", "relational"] as const;

function openDb(): DatabaseSync {
  return new DatabaseSync(loadConfigForTools().dbPath);
}

export function loadConfigForTools(): BrainConfig {
  return loadConfig();
}

export function toolBrainSearch(args: {
  query: string;
  limit?: number;
  offset?: number;
  type?: string[];
  tag?: string;
  pathPrefix?: string;
}): unknown {
  const config = loadConfigForTools();
  return searchDocuments({
    dbPath: config.dbPath,
    query: args.query,
    limit: args.limit,
    offset: args.offset,
    filters: {
      ...(args.type && args.type.length > 0 ? { type: args.type } : {}),
      ...(args.tag ? { tag: args.tag } : {}),
      ...(args.pathPrefix ? { pathPrefix: args.pathPrefix } : {}),
    },
  });
}

export function toolBrainResolve(args: { query: string }): unknown {
  const db = openDb();
  try {
    return resolveEntity(db, args.query);
  } finally {
    db.close();
  }
}

export function toolBrainGet(args: { id: string }): unknown {
  const db = openDb();
  try {
    const entity = getEntity(db, args.id);
    const out = db
      .prepare("SELECT COUNT(*) AS c FROM relations WHERE source_entity = ?")
      .get(entity.id) as { c: number };
    const inc = db
      .prepare("SELECT COUNT(*) AS c FROM relations WHERE target_entity = ?")
      .get(entity.id) as { c: number };
    const doc = db
      .prepare(
        `SELECT d.path AS path FROM documents d
         JOIN entities e ON e.origin_document_id = d.id WHERE e.id = ?`,
      )
      .get(entity.id) as { path: string } | undefined;

    return {
      entity,
      stats: {
        outgoingRelations: out?.c ?? 0,
        incomingRelations: inc?.c ?? 0,
        originDocumentPath: doc?.path ?? null,
      },
    };
  } finally {
    db.close();
  }
}

interface RelatedArgs {
  id: string;
  depth?: number;
  direction?: "out" | "in" | "both";
  relationTypes?: string[];
  asOf?: string;
}

export function toolBrainRelated(args: RelatedArgs): unknown {
  const db = openDb();
  try {
    const resolution = resolveEntity(db, args.id);
    if (!resolution.best) {
      throw new NotFoundError(`no entity for "${args.id}"`);
    }
    const entityId = resolution.best.entity.id;

    if ((args.depth ?? 1) > 1) {
      const maxDepth = Math.max(1, Math.min(5, args.depth ?? 1));
      const visited = new Map<string, number>([[entityId, 0]]);
      const edgeMap = new Map<number, ReturnType<typeof relatedEdges>[number]>();
      let frontier = [entityId];

      for (let depth = 1; depth <= maxDepth; depth++) {
        const next: string[] = [];
        for (const nodeId of frontier) {
          const edges = relatedEdges(db, nodeId, {
            direction: args.direction ?? "both",
            relationTypes: args.relationTypes,
            asOf: args.asOf,
          });
          for (const edge of edges) {
            edgeMap.set(edge.relationId, edge);
            const neighbor = edge.source === nodeId ? edge.target : edge.source;
            if (!visited.has(neighbor)) {
              visited.set(neighbor, depth);
              next.push(neighbor);
            }
          }
        }
        if (next.length === 0) break;
        frontier = next;
      }

      return {
        resolvedBy: resolution.best.method,
        start: entityId,
        nodes: [...visited.entries()]
          .map(([id, d]) => ({ id, depth: d }))
          .sort((a, b) => a.depth - b.depth),
        edges: [...edgeMap.values()],
      };
    }

    const edges = relatedEdges(db, entityId, {
      direction: args.direction ?? "both",
      relationTypes: args.relationTypes,
      asOf: args.asOf,
    });
    return { resolvedBy: resolution.best.method, start: entityId, edges };
  } finally {
    db.close();
  }
}

export function toolBrainContext(args: {
  subject: string;
  task?: string;
  depth?: number;
  maxChars?: number;
}): unknown {
  const config = loadConfigForTools();
  return buildContext({
    dbPath: config.dbPath,
    subject: args.subject,
    task: args.task,
    depth: args.depth,
    maxChars: args.maxChars,
  });
}

export function toolBrainTimeline(args: {
  entityId: string;
  limit?: number;
  kinds?: Array<"event" | "relation" | "document" | "memory">;
}): unknown {
  const db = openDb();
  try {
    const resolution = resolveEntity(db, args.entityId);
    if (!resolution.best) {
      throw new NotFoundError(`no entity for "${args.entityId}"`);
    }
    const entries = buildTimeline(db, {
      entityId: resolution.best.entity.id,
      limit: args.limit,
      kinds: args.kinds,
    });
    return { entityId: resolution.best.entity.id, entries };
  } finally {
    db.close();
  }
}

export function toolBrainSources(args: { entityId?: string }): unknown {
  const db = openDb();
  try {
    if (args.entityId) {
      const resolution = resolveEntity(db, args.entityId);
      if (!resolution.best) {
        throw new NotFoundError(`no entity for "${args.entityId}"`);
      }
      const id = resolution.best.entity.id;
      const originDoc = db
        .prepare(
          `SELECT d.path AS path FROM documents d
           JOIN entities e ON e.origin_document_id = d.id WHERE e.id = ?`,
        )
        .get(id) as { path: string } | undefined;
      const relSources = db
        .prepare(
          `SELECT DISTINCT s.id AS id, s.source_type AS sourceType, s.location AS location
           FROM relations r JOIN sources s ON s.id = r.source_id
           WHERE r.source_entity = ? OR r.target_entity = ?`,
        )
        .all(id, id);
      return {
        entityId: id,
        originDocument: originDoc
          ? { sourceType: "obsidian", location: originDoc.path }
          : null,
        relationSources: relSources,
      };
    }

    const sources = db
      .prepare(
        "SELECT id AS id, source_type AS sourceType, location AS location FROM sources ORDER BY id",
      )
      .all();
    const countsByType = db
      .prepare("SELECT source_type AS sourceType, COUNT(*) AS total FROM sources GROUP BY source_type")
      .all();
    return { sources, countsByType };
  } finally {
    db.close();
  }
}

function ensureConversationSource(db: DatabaseSync): void {
  db.prepare(
    `INSERT INTO sources (id, source_type, location) VALUES (?, 'conversation', 'mcp')
     ON CONFLICT(id) DO NOTHING`,
  ).run(CONVERSATION_SOURCE_ID);
}

export function toolBrainRemember(args: {
  content: string;
  memory_kind: (typeof MEMORY_KINDS)[number];
  category?: string;
  entityId?: string;
  confidence?: number;
}): unknown {
  if (!args.content || args.content.trim() === "") {
    throw new ValidationError("memory content is empty");
  }
  if (!MEMORY_KINDS.includes(args.memory_kind)) {
    throw new ValidationError("invalid memory_kind", { allowed: MEMORY_KINDS });
  }

  const db = openDb();
  try {
    db.exec("BEGIN");
    ensureConversationSource(db);

    let entityId: string | null = null;
    if (args.entityId && args.entityId.trim() !== "") {
      const resolution = resolveEntity(db, args.entityId);
      if (!resolution.best) {
        throw new NotFoundError(`no entity for "${args.entityId}"`);
      }
      entityId = resolution.best.entity.id;
    }

    const inserted = db
      .prepare(
        `INSERT INTO memories (memory_kind, category, content, entity_id, confidence, source_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        args.memory_kind,
        args.category ?? null,
        args.content.trim(),
        entityId,
        args.confidence ?? 0.8,
        CONVERSATION_SOURCE_ID,
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

export function toolBrainLink(args: {
  sourceEntity: string;
  targetEntity: string;
  relationType: string;
  confidence?: number;
  validFrom?: string;
}): unknown {
  if (!args.sourceEntity?.trim() || !args.targetEntity?.trim()) {
    throw new ValidationError("sourceEntity and targetEntity are required");
  }
  if (!args.relationType?.trim()) {
    throw new ValidationError("relationType is required");
  }

  const db = openDb();
  try {
    db.exec("BEGIN");
    ensureConversationSource(db);

    const src = resolveEntity(db, args.sourceEntity);
    if (!src.best) throw new NotFoundError(`no entity for "${args.sourceEntity}"`);
    const tgt = resolveEntity(db, args.targetEntity);
    if (!tgt.best) throw new NotFoundError(`no entity for "${args.targetEntity}"`);

    const inserted = db
      .prepare(
        `INSERT INTO relations
           (source_entity, relation_type, target_entity, confidence, valid_from, source_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        src.best.entity.id,
        args.relationType.trim().toUpperCase(),
        tgt.best.entity.id,
        args.confidence ?? 0.9,
        args.validFrom ?? new Date().toISOString(),
        CONVERSATION_SOURCE_ID,
      );
    const relationId = Number(inserted.lastInsertRowid);

    db.prepare(
      `INSERT INTO events (event_type, subject, payload)
       VALUES ('relation.created', ?, ?)`,
    ).run(src.best.entity.id, JSON.stringify({ relationId, target: tgt.best.entity.id }));

    db.exec("COMMIT");
    return {
      ok: true,
      relationId,
      source: src.best.entity.id,
      target: tgt.best.entity.id,
      relationType: args.relationType.trim().toUpperCase(),
    };
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  } finally {
    db.close();
  }
}

export function toolBrainHealth(): unknown {
  const config = loadConfigForTools();
  if (!existsSync(config.dbPath)) {
    return {
      ok: false,
      reason: "database not initialized",
      vaultPath: config.vaultPath,
      dbPath: config.dbPath,
    };
  }
  const db = new DatabaseSync(config.dbPath);
  try {
    applySchema(db);
    const counts = db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM documents) AS documents,
          (SELECT COUNT(*) FROM entities)  AS entities,
          (SELECT COUNT(*) FROM relations) AS relations,
          (SELECT COUNT(*) FROM memories)  AS memories,
          (SELECT COUNT(*) FROM events)    AS events,
          (SELECT COUNT(*) FROM skills WHERE status='active')     AS skills,
          (SELECT COUNT(*) FROM tools_registry WHERE available=1) AS tools,
          (SELECT COUNT(*) FROM agents WHERE status='active')     AS agents,
          (SELECT COUNT(*) FROM observations WHERE status='candidate') AS learning_candidates`,
      )
      .get() as Record<string, number>;
    const metaRows = db
      .prepare("SELECT key, value FROM index_metadata")
      .all() as unknown as Array<{ key: string; value: string }>;
    const metadata: Record<string, string> = {};
    for (const row of metaRows) metadata[row.key] = row.value;

    return {
      ok: true,
      counts,
      lastIndexedAt: metadata.last_indexed_at ?? null,
      schemaVersion: Number(metadata.schema_version ?? 0),
      vaultExists: existsSync(config.vaultPath),
      vaultPath: config.vaultPath,
      dbPath: config.dbPath,
      dbSizeBytes: statSync(config.dbPath).size,
    };
  } finally {
    db.close();
  }
}
