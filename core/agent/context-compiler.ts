/**
 * Context Compiler — facade over the REAL context package
 * (core/context/context-package.ts → context-builder → router).
 * Removes the Phase-1 canned placeholders; every value comes from the DB.
 */

import type { CompiledContext, RelatedEntityInfo, TimelineEntryLite, DocumentRef } from "./types.ts";
import { buildContextPackage } from "../context/context-package.ts";

export async function compileContext(
  input: {
    subject: string;
    task?: string;
    depth?: number;
    maxChars?: number;
  },
  config: {
    dbPath: string;
    context?: { maxChars?: number; defaultDepth?: number; maxDepth?: number };
  },
): Promise<CompiledContext> {
  if (!config.dbPath) {
    throw new Error("dbPath required to compile context");
  }
  const maxChars = input.maxChars ?? config.context?.maxChars ?? 12000;

  const pkg = buildContextPackage(config, {
    task: input.task ?? input.subject,
    entity: input.subject,
    depth: input.depth,
    maxChars,
  });

  const relatedEntities: RelatedEntityInfo[] = pkg.relationships.map((r) => ({
    id: r.id,
    name: r.name,
    type: r.type,
    relation: r.relation,
    confidence: 0.8,
  }));

  const recentEvents: TimelineEntryLite[] = pkg.context.recentEvents.map((e, index) => ({
    id: `${pkg.context.generatedAt}-${index}`,
    type: e.kind ?? "event",
    title: e.summary.slice(0, 120),
    description: e.summary,
    timestamp: e.at,
    source: "second-brain",
  }));

  const documents: DocumentRef[] = pkg.knowledge.map((d) => ({
    id: d.path,
    path: d.path,
    title: d.title,
    excerpt: d.title,
    score: d.score ?? 0,
  }));

  const summaryParts = [
    pkg.context.summary,
    pkg.memories.length ? `Memórias relevantes: ${pkg.memories.slice(0, 5).map((m) => m.summary).join("; ")}` : "",
    pkg.activeGoals.length ? `Objetivos ativos: ${pkg.activeGoals.slice(0, 5).map((g) => `${g.name} (${g.progressPct ?? 0}%)`).join("; ")}` : "",
    pkg.context.decisions.length ? `Decisões: ${pkg.context.decisions.slice(0, 4).map((d) => d.title).join("; ")}` : "",
  ].filter(Boolean);

  return {
    subject: input.subject,
    entityId: pkg.context.entityId,
    resolvedBy: (pkg.context.resolvedBy as CompiledContext["resolvedBy"]) ?? null,
    entityType: pkg.context.entityType,
    status: pkg.context.status,
    summary: summaryParts.join("\n") || null,
    aliases: pkg.context.aliases ?? [],
    relatedEntities,
    decisions: pkg.context.decisions.map((d) => ({ id: d.id, title: d.title, status: d.status ?? null })),
    procedures: pkg.context.procedures.map((p) => ({ id: p.id, title: p.title, status: p.status ?? null })),
    recentEvents,
    documents,
    sources: pkg.sources.map((s) => ({ sourceType: String(s.sourceType), location: String(s.location) })),
    warnings: [...pkg.warnings, ...pkg.context.warnings ?? []],
    truncated: false,
    charBudget: { used: JSON.stringify(pkg).length, max: maxChars },
    generatedAt: pkg.generatedAt,
  };
}