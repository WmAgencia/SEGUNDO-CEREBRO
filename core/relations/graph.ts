import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";

export type Direction = "out" | "in" | "both";

export interface GraphEdge {
  relationId: number;
  source: string;
  target: string;
  relationType: string;
  confidence: number;
  validFrom: string | null;
  validUntil: string | null;
  sourceId: string | null;
}

export interface RelatedOptions {
  direction?: Direction;
  relationTypes?: string[];
  asOf?: string;
}

export function defaultAsOf(): string {
  return new Date().toISOString();
}

const TEMPORAL_CLAUSE = `(r.valid_from IS NULL OR r.valid_from <= ?)
      AND (r.valid_until IS NULL OR r.valid_until > ?)`;

export interface EdgeRow {
  id: number;
  source_entity: string;
  target_entity: string;
  relation_type: string;
  confidence: number;
  valid_from: string | null;
  valid_until: string | null;
  source_id: string | null;
}

function fetchEdges(
  db: DatabaseSync,
  entityId: string,
  opts: Required<Pick<RelatedOptions, "direction">> & RelatedOptions,
): GraphEdge[] {
  const asOf = opts.asOf ?? defaultAsOf();
  const clauses = [TEMPORAL_CLAUSE];
  const values: Array<string | number> = [asOf, asOf];

  if (opts.direction === "out") {
    clauses.push("r.source_entity = ?");
    values.push(entityId);
  } else if (opts.direction === "in") {
    clauses.push("r.target_entity = ?");
    values.push(entityId);
  } else {
    clauses.push("(r.source_entity = ? OR r.target_entity = ?)");
    values.push(entityId, entityId);
  }

  if (opts.relationTypes && opts.relationTypes.length > 0) {
    clauses.push(
      `r.relation_type IN (${opts.relationTypes.map(() => "?").join(",")})`,
    );
    for (const t of opts.relationTypes) values.push(t.toUpperCase());
  }

  const rows = db
    .prepare(
      `SELECT r.id AS id, r.source_entity AS source_entity,
              r.target_entity AS target_entity,
              r.relation_type AS relation_type,
              r.confidence AS confidence,
              r.valid_from AS valid_from,
              r.valid_until AS valid_until,
              r.source_id AS source_id
       FROM relations r
       WHERE ${clauses.join(" AND ")}`,
    )
    .all(...values) as unknown as EdgeRow[];

  return rows.map((r) => ({
    relationId: r.id,
    source: r.source_entity,
    target: r.target_entity,
    relationType: r.relation_type,
    confidence: r.confidence,
    validFrom: r.valid_from,
    validUntil: r.valid_until,
    sourceId: r.source_id,
  }));
}

export function relatedEdges(
  db: DatabaseSync,
  entityId: string,
  options: RelatedOptions = {},
): GraphEdge[] {
  return fetchEdges(db, entityId, {
    direction: options.direction ?? "both",
    relationTypes: options.relationTypes,
    asOf: options.asOf,
  });
}

export interface TraversalNode {
  id: string;
  depth: number;
}

export interface TraversalResult {
  start: string;
  nodes: TraversalNode[];
  edges: GraphEdge[];
}

export interface TraverseOptions extends RelatedOptions {
  maxDepth?: number;
}

export function traverseGraph(
  db: DatabaseSync,
  startId: string,
  options: TraverseOptions = {},
): TraversalResult {
  const maxDepth = Math.max(1, Math.min(5, options.maxDepth ?? 1));
  const visited = new Map<string, number>([[startId, 0]]);
  const edgesByKey = new Map<string, GraphEdge>();
  let frontier: string[] = [startId];

  for (let depth = 1; depth <= maxDepth; depth++) {
    const nextFrontier: string[] = [];
    for (const nodeId of frontier) {
      const edges = fetchEdges(db, nodeId, {
        direction: options.direction ?? "both",
        relationTypes: options.relationTypes,
        asOf: options.asOf,
      });
      for (const edge of edges) {
        const key = `${edge.relationId}`;
        if (!edgesByKey.has(key)) edgesByKey.set(key, edge);
        const neighbor = edge.source === nodeId ? edge.target : edge.source;
        if (!visited.has(neighbor)) {
          visited.set(neighbor, depth);
          nextFrontier.push(neighbor);
        }
      }
    }
    if (nextFrontier.length === 0) break;
    frontier = nextFrontier;
  }

  const nodes: TraversalNode[] = [...visited.entries()]
    .map(([id, depth]) => ({ id, depth }))
    .sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));

  return { start: startId, nodes, edges: [...edgesByKey.values()] };
}

export function closeRelation(
  db: DatabaseSync,
  relationId: number,
  until: string,
): boolean {
  const result = db
    .prepare(
      `UPDATE relations SET valid_until = ?
       WHERE id = ? AND valid_until IS NULL`,
    )
    .run(until, relationId);
  return Number(result.changes) > 0;
}

export interface NewRelationInput {
  sourceEntity: string;
  targetEntity: string;
  relationType: string;
  confidence?: number;
  validFrom?: string;
  sourceId?: string | null;
}

export function supersedeRelation(
  db: DatabaseSync,
  oldRelationId: number,
  replacement: NewRelationInput,
  options: { closeUntil?: string; newValidFrom?: string } = {},
): number {
  const until = options.closeUntil ?? new Date().toISOString();
  const validFrom = options.newValidFrom ?? new Date().toISOString();

  const existing = db
    .prepare("SELECT id, valid_until FROM relations WHERE id = ?")
    .get(oldRelationId) as { id: number; valid_until: string | null } | undefined;
  if (!existing) {
    throw new ValidationError(`relation not found: ${oldRelationId}`, {
      relationId: oldRelationId,
    });
  }
  if (existing.valid_until !== null) {
    throw new ValidationError(
      `relation ${oldRelationId} is already closed at ${existing.valid_until}`,
      { relationId: oldRelationId },
    );
  }

  db.exec("BEGIN");
  try {
    db.prepare("UPDATE relations SET valid_until = ? WHERE id = ?").run(
      until,
      oldRelationId,
    );
    const inserted = db
      .prepare(
        `INSERT INTO relations
           (source_entity, relation_type, target_entity, confidence,
            valid_from, source_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        replacement.sourceEntity,
        replacement.relationType.toUpperCase(),
        replacement.targetEntity,
        replacement.confidence ?? 1,
        validFrom,
        replacement.sourceId ?? null,
      );
    db.exec("COMMIT");
    return Number(inserted.lastInsertRowid);
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {}
    throw err;
  }
}
