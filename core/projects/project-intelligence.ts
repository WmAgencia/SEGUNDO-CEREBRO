import { DatabaseSync } from "node:sqlite";
import { NotFoundError } from "../errors/errors.ts";
import type { BrainConfig } from "../config/loader.ts";
import {
  findEntityOptional,
  getEntityStats,
} from "../entities/entity.ts";
import type { EntityRecord } from "../entities/entity.ts";
import { resolveEntity } from "../entities/resolver.ts";
import { relatedEdges } from "../relations/graph.ts";
import { buildTimeline } from "../retrieval/timeline.ts";
import { searchMemories } from "../memory/memory-engine.ts";
import { searchSkills } from "../skills/skill-engine.ts";
import { resolveTools } from "../tools/tool-registry.ts";

export interface ProjectIntelligence {
  entity: EntityRecord;
  stats: ReturnType<typeof getEntityStats>;
  relatedByType: Record<
    string,
    Array<{ id: string; name: string; relation: string; direction: string }>
  >;
  decisions: Array<{ id: string; title: string; status: string | null }>;
  procedures: Array<{ id: string; title: string; status: string | null }>;
  memories: Array<{ id: number; content: string; importance: number }>;
  documents: Array<{ path: string; title: string | null }>;
  skills: ReturnType<typeof searchSkills>;
  tools: ReturnType<typeof resolveTools>;
  timeline: Array<{ at: string; kind: string; summary: string }>;
  projectRelations: Array<{ otherProject: string; relation: string }>;
}

export function getProjectIntelligence(
  config: BrainConfig,
  projectIdOrName: string,
): ProjectIntelligence {
  const db = new DatabaseSync(config.dbPath);
  try {
    const resolution = resolveEntity(db, projectIdOrName);
    let entity = resolution.best?.entity;
    if (entity && entity.type !== "project") entity = undefined;

    if (!entity) {
      throw new NotFoundError(
        `projeto não encontrado: ${projectIdOrName}`,
      );
    }

    const stats = getEntityStats(db, entity.id);
    const edges = relatedEdges(db, entity.id, { direction: "both" });

    const relatedByType: ProjectIntelligence["relatedByType"] = {};
    const decisions: ProjectIntelligence["decisions"] = [];
    const procedures: ProjectIntelligence["procedures"] = [];
    const projectRelations: ProjectIntelligence["projectRelations"] = [];
    const seenDecisions = new Set<string>();
    const seenProcedures = new Set<string>();

    for (const edge of edges) {
      const isOut = edge.source === entity.id;
      const otherId = isOut ? edge.target : edge.source;
      if (otherId === entity.id) continue;
      const other = findEntityOptional(db, otherId);
      if (!other) continue;

      const direction = isOut ? "out" : "in";
      (relatedByType[other.type] ??= []).push({
        id: other.id,
        name: other.canonicalName,
        relation: edge.relationType,
        direction,
      });

      if (other.type === "decision") {
        if (!seenDecisions.has(other.id)) {
          seenDecisions.add(other.id);
          decisions.push({ id: other.id, title: other.canonicalName, status: other.status });
        }
      } else if (other.type === "procedure") {
        if (!seenProcedures.has(other.id)) {
          seenProcedures.add(other.id);
          procedures.push({ id: other.id, title: other.canonicalName, status: other.status });
        }
      } else if (other.type === "project") {
        projectRelations.push({
          otherProject: other.id,
          relation: `${edge.relationType} (${direction})`,
        });
      }
    }

    const memories = searchMemories(db, { entityId: entity.id, limit: 10 }).map(
      (m) => ({
        id: m.id,
        content: m.content.length > 140 ? `${m.content.slice(0, 137)}…` : m.content,
        importance: m.importance,
      }),
    );

    const docRow = db
      .prepare(
        `SELECT d.path AS path, d.title AS title FROM documents d
         JOIN entities e ON e.origin_document_id = d.id WHERE e.id = ?`,
      )
      .get(entity.id) as { path: string; title: string | null } | undefined;
    const documents = docRow
      ? [{ path: docRow.path, title: docRow.title }]
      : [];

    return {
      entity,
      stats,
      relatedByType,
      decisions,
      procedures,
      memories,
      documents,
      skills: searchSkills(db, entity.canonicalName),
      tools: resolveTools(db, entity.canonicalName, { limit: 5 }),
      timeline: buildTimeline(db, { entityId: entity.id, limit: 10 }).map((t) => ({
        at: t.at,
        kind: t.kind,
        summary: t.summary,
      })),
      projectRelations,
    };
  } finally {
    db.close();
  }
}
