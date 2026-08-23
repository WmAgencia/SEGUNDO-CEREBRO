import type { BrainConfig } from "./config/loader.ts";
import { routeQuery } from "./orchestrator/router.ts";
import type { RoutePlan } from "./orchestrator/router.ts";
import { resolveEntity } from "./entities/resolver.ts";
import { DatabaseSync } from "node:sqlite";
import { buildContextPackage } from "./context/context-package.ts";
import type { ContextPackage } from "./context/context-package.ts";
import { searchSkills } from "./skills/skill-engine.ts";
import { resolveTools } from "./tools/tool-registry.ts";
import { listAgents } from "./agents/agent-runtime.ts";
import type { AgentRecord } from "./agents/agent-runtime.ts";

export interface UnifiedQueryInput {
  query: string;
  agentId?: string;
  depth?: number;
  maxChars?: number;
}

export interface UnifiedResponse {
  query: string;
  intent: RoutePlan["intent"];
  entities: string[];
  project: string | null;
  context: ContextPackage;
  memories: ContextPackage["memories"];
  knowledge: ContextPackage["knowledge"];
  decisions: ContextPackage["decisions"];
  procedures: ContextPackage["procedures"];
  relationships: ContextPackage["relationships"];
  skills: ReturnType<typeof searchSkills>;
  tools: ReturnType<typeof resolveTools>;
  agents: Array<Pick<AgentRecord, "id" | "name" | "domains">>;
  sources: ContextPackage["sources"];
  warnings: string[];
  generatedAt: string;
}

export function unifiedQuery(
  config: BrainConfig,
  input: UnifiedQueryInput,
): UnifiedResponse {
  if (!input.query || input.query.trim() === "") {
    throw new Error("query is required");
  }
  const route = routeQuery(input.query);
  const warnings: string[] = [];

  const pkg = buildContextPackage(config, {
    task: input.query,
    depth: input.depth,
    maxChars: input.maxChars,
  });

  const db = new DatabaseSync(config.dbPath);
  let skills: UnifiedResponse["skills"] = { primary: [], supporting: [] };
  let tools: UnifiedResponse["tools"] = [];
  let agents: UnifiedResponse["agents"] = [];
  try {
    skills = searchSkills(db, input.query);
    const toolFilters: Parameters<typeof resolveTools>[2] = { limit: 5 };
    tools = route.typeFilters.includes("procedure")
      ? resolveTools(db, input.query, {
          ...toolFilters,
          requirePermission: "EXECUTE",
        })
      : resolveTools(db, input.query, toolFilters);

    const allAgents = listAgents(db);
    const q = input.query.toLowerCase();
    agents = allAgents
      .filter(
        (a) =>
          a.status === "active" &&
          (a.domains.some((d) => q.includes(d.toLowerCase())) ||
            a.name
              .toLowerCase()
              .split(" ")
              .some((w) => w.length > 3 && q.includes(w))),
      )
      .slice(0, 5)
      .map((a) => ({ id: a.id, name: a.name, domains: a.domains }));

    db.prepare(
      `INSERT INTO events (event_type, subject, payload) VALUES ('unified.query', ?, ?)`,
    ).run(input.query.slice(0, 200), JSON.stringify({ intent: route.intent }));
  } catch {
    warnings.push("skills/tools/agents indisponíveis nesta consulta");
  } finally {
    db.close();
  }

  return {
    query: input.query,
    intent: route.intent,
    entities: pkg.entities,
    project: pkg.project,
    context: pkg,
    memories: pkg.memories,
    knowledge: pkg.knowledge,
    decisions: pkg.decisions,
    procedures: pkg.procedures,
    relationships: pkg.relationships,
    skills,
    tools,
    agents,
    sources: pkg.sources,
    warnings: [...warnings, ...pkg.warnings],
    generatedAt: new Date().toISOString(),
  };
}
