import { DatabaseSync } from "node:sqlite";
import { routeQuery } from "../orchestrator/router.ts";
import type { RoutePlan } from "../orchestrator/router.ts";
import { buildContext } from "../context/context-builder.ts";
import type { BrainContext } from "../context/context-builder.ts";
import { searchMemories } from "../memory/memory-engine.ts";
import type { MemoryRecord } from "../memory/memory-engine.ts";
import { listActiveGoalsByPriority } from "../goals/goal-engine.ts";
import type { BrainConfig } from "../config/loader.ts";
import { ValidationError } from "../errors/errors.ts";

export interface ContextPackageInput {
  task: string;
  project?: string;
  entity?: string;
  depth?: number;
  maxChars?: number;
}

export interface ContextPackage {
  task: string;
  intent: RoutePlan["intent"];
  entities: string[];
  project: string | null;
  context: BrainContext;
  memories: Array<{
    id: number;
    category: string | null;
    summary: string;
    importance: number;
  }>;
  activeGoals: Array<{
    id: string;
    name: string;
    type: string;
    progressPct: number | null;
    score: number;
    reasons: string[];
  }>;
  decisions: BrainContext["decisions"];
  procedures: BrainContext["procedures"];
  relationships: BrainContext["relatedEntities"];
  knowledge: BrainContext["documents"];
  tools: unknown[];
  skills: unknown[];
  sources: BrainContext["sources"];
  warnings: string[];
  generatedAt: string;
}

export function buildContextPackage(
  config: Pick<BrainConfig, "dbPath">,
  input: ContextPackageInput,
): ContextPackage {
  if (!input.task || input.task.trim() === "") {
    throw new ValidationError("task is required for context package");
  }
  const route = routeQuery(input.task);
  const subject = input.entity ?? input.project ?? input.task;

  const context = buildContext({
    dbPath: config.dbPath,
    subject,
    task: input.task,
    depth: input.depth,
    maxChars: input.maxChars,
  });

  const db = new DatabaseSync(config.dbPath);
  let memories: ContextPackage["memories"] = [];
  let activeGoals: ContextPackage["activeGoals"] = [];
  try {
    const memoryFilters: Parameters<typeof searchMemories>[1] = {
      limit: 5,
    };
    if (input.project) memoryFilters.project = input.project;
    if (context.entityId) memoryFilters.entityId = context.entityId;
    if (route.typeFilters.length > 0) {
      memoryFilters.category = route.typeFilters.includes("decision")
        ? "DECISION"
        : undefined;
    }
    memories = searchMemories(db, memoryFilters).map((m) => ({
      id: m.id,
      category: m.category,
      summary:
        m.content.length > 160 ? `${m.content.slice(0, 157)}…` : m.content,
      importance: m.importance,
    }));

    activeGoals = listActiveGoalsByPriority(db, 3).map((g) => ({
      id: g.id,
      name: g.name,
      type: g.type,
      progressPct: g.progressPct,
      score: g.score,
      reasons: g.reasons,
    }));
  } catch {
    context.warnings.push("memórias indisponíveis neste pacote");
  } finally {
    db.close();
  }

  const warnings = [...context.warnings];
  if (!context.entityId) {
    warnings.push("nenhuma entidade resolvida para esta tarefa");
  }

  return {
    task: input.task,
    intent: route.intent,
    entities: context.entityId ? [context.entityId] : [],
    project: input.project ?? null,
    context,
    memories,
    activeGoals,
    decisions: context.decisions,
    procedures: context.procedures,
    relationships: context.relatedEntities,
    knowledge: context.documents,
    tools: [],
    skills: [],
    sources: context.sources,
    warnings,
    generatedAt: new Date().toISOString(),
  };
}
