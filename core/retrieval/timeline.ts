import type { DatabaseSync } from "node:sqlite";

export type TimelineKind = "event" | "relation" | "document" | "memory";

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  summary: string;
  ref: Record<string, unknown>;
}

export interface TimelineOptions {
  entityId: string;
  asOf?: string;
  limit?: number;
  kinds?: TimelineKind[];
}

export function buildTimeline(
  db: DatabaseSync,
  options: TimelineOptions,
): TimelineEntry[] {
  const { entityId } = options;
  const limit = Math.max(1, Math.min(200, options.limit ?? 50));
  const entries: TimelineEntry[] = [];

  const eventRows = db
    .prepare(
      `SELECT event_type, subject, payload, occurred_at
       FROM events WHERE subject = ? ORDER BY occurred_at DESC LIMIT 100`,
    )
    .all(entityId) as unknown as Array<{
    event_type: string;
    subject: string;
    payload: string;
    occurred_at: string;
  }>;
  for (const row of eventRows) {
    entries.push({
      at: row.occurred_at,
      kind: "event",
      summary: `${row.event_type} (${row.subject})`,
      ref: { eventType: row.event_type, payload: safeJson(row.payload) },
    });
  }

  const relationRows = db
    .prepare(
      `SELECT id, source_entity, target_entity, relation_type, confidence,
              valid_from, valid_until,
              COALESCE(valid_from, created_at) AS at
       FROM relations
       WHERE source_entity = ? OR target_entity = ?
       ORDER BY at DESC LIMIT 100`,
    )
    .all(entityId, entityId) as unknown as Array<{
    id: number;
    source_entity: string;
    target_entity: string;
    relation_type: string;
    confidence: number;
    valid_from: string | null;
    valid_until: string | null;
    at: string | null;
  }>;
  for (const row of relationRows) {
    if (!row.at) continue;
    const arrow = `${row.source_entity} -[${row.relation_type}]-> ${row.target_entity}`;
    const closed = row.valid_until ? ` (até ${row.valid_until})` : "";
    entries.push({
      at: row.at,
      kind: "relation",
      summary: `${arrow} conf=${row.confidence}${closed}`,
      ref: {
        relationId: row.id,
        source: row.source_entity,
        target: row.target_entity,
        relationType: row.relation_type,
        validFrom: row.valid_from,
        validUntil: row.valid_until,
      },
    });
  }

  const docRow = db
    .prepare(
      `SELECT d.path AS path, d.title AS title, d.modified_at AS modified_at,
              d.created_at AS created_at
       FROM documents d
       JOIN entities e ON e.origin_document_id = d.id
       WHERE e.id = ?`,
    )
    .get(entityId) as
    | {
        path: string;
        title: string | null;
        modified_at: string | null;
        created_at: string | null;
      }
    | undefined;
  if (docRow) {
    const at = docRow.modified_at ?? docRow.created_at;
    if (at) {
      entries.push({
        at,
        kind: "document",
        summary: `documento "${docRow.title ?? docRow.path}" modificado`,
        ref: { path: docRow.path },
      });
    }
  }

  const memoryRows = db
    .prepare(
      `SELECT id, memory_kind, content, created_at
       FROM memories WHERE entity_id = ?
       ORDER BY created_at DESC LIMIT 100`,
    )
    .all(entityId) as unknown as Array<{
    id: number;
    memory_kind: string;
    content: string;
    created_at: string;
  }>;
  for (const row of memoryRows) {
    entries.push({
      at: row.created_at,
      kind: "memory",
      summary: `[${row.memory_kind}] ${row.content.slice(0, 120)}`,
      ref: { memoryId: row.id },
    });
  }

  const filtered =
    options.kinds && options.kinds.length > 0
      ? entries.filter((e) => options.kinds?.includes(e.kind))
      : entries;

  filtered.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return filtered.slice(0, limit);
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {}
  return {};
}
