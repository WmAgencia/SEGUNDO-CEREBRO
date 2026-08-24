import { DatabaseSync } from "node:sqlite";
import { ValidationError } from "../errors/errors.ts";

export interface ToolRecord {
  id: string;
  name: string | null;
  description: string;
  category: string;
  permissions: string[];
  origin: string;
  available: boolean;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  sideEffects: string[];
  riskLevel: string;
}

interface RawTool {
  id: string;
  name: string | null;
  description: string;
  category: string;
  permissions: string;
  origin: string;
  available: number;
  input_schema?: string;
  output_schema?: string;
  side_effects?: string;
  risk_level?: string;
  risk?: string;
}

function toTool(r: RawTool): ToolRecord {
  let perms: string[] = [];
  try {
    const p = JSON.parse(r.permissions);
    if (Array.isArray(p)) perms = p.filter((x): x is string => typeof x === "string");
  } catch {}
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    category: r.category,
    permissions: perms,
    origin: r.origin,
    available: r.available === 1,
    inputSchema: parseJsonObject(r.input_schema ?? "{}"),
    outputSchema: parseJsonObject(r.output_schema ?? "{}"),
    sideEffects: parseJsonArray(r.side_effects ?? "[]"),
    riskLevel: r.risk_level ?? r.risk ?? "LOW",
  };
}

export interface RegisterToolInput {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  permissions?: string[];
  origin?: string;
  available?: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  sideEffects?: string[];
  riskLevel?: string;
  risk?: string;
}

export function registerTool(
  db: DatabaseSync,
  input: RegisterToolInput,
): ToolRecord {
  if (!input.id.trim()) throw new ValidationError("tool id required");
  db.prepare(
    `INSERT INTO tools_registry (id, name, description, category, permissions, origin, available, input_schema, output_schema, side_effects, risk_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name=excluded.name, description=excluded.description, category=excluded.category,
        permissions=excluded.permissions, origin=excluded.origin, available=excluded.available,
        input_schema=excluded.input_schema, output_schema=excluded.output_schema,
        side_effects=excluded.side_effects, risk_level=excluded.risk_level`,
  ).run(
    input.id,
    input.name ?? null,
    input.description ?? "",
    input.category ?? "general",
    JSON.stringify(input.permissions ?? ["READ"]),
    input.origin ?? "local",
    input.available === false ? 0 : 1,
    JSON.stringify(input.inputSchema ?? {}), JSON.stringify(input.outputSchema ?? {}),
    JSON.stringify(input.sideEffects ?? []), input.riskLevel ?? input.risk ?? "LOW",
  );
  return getTool(db, input.id);
}

function parseJsonArray(raw: string): string[] {
  try { const value = JSON.parse(raw); return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []; } catch { return []; }
}
function parseJsonObject(raw: string): Record<string, unknown> {
  try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}

export function getTool(db: DatabaseSync, id: string): ToolRecord {
  const row = db
    .prepare("SELECT * FROM tools_registry WHERE id = ?")
    .get(id) as RawTool | undefined;
  if (!row) throw new ValidationError(`tool not found: ${id}`);
  return toTool(row);
}

export function listTools(db: DatabaseSync): ToolRecord[] {
  return (db.prepare("SELECT * FROM tools_registry ORDER BY id").all() as unknown as RawTool[]).map(toTool);
}

export function setToolAvailability(db: DatabaseSync, id: string, available: boolean): void {
  db.prepare("UPDATE tools_registry SET available = ? WHERE id = ?").run(available ? 1 : 0, id);
}

export interface ResolvedTool extends ToolRecord {
  score: number;
  reason: string;
}

const STOPWORDS = new Set([
  "para", "com", "que", "uma", "dos", "das", "por", "como", "preciso", "quero",
  "fazer", "the", "and", "for", "with", "this", "that",
]);

export function resolveTools(
  db: DatabaseSync,
  task: string,
  options: { requirePermission?: "READ" | "WRITE" | "EXECUTE" | "DELETE" | "NETWORK" | "ADMIN"; limit?: number } = {},
): ResolvedTool[] {
  const tokens = (task.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t),
  );
  if (tokens.length === 0) return [];

  const results: ResolvedTool[] = [];
  for (const tool of listTools(db)) {
    if (!tool.available) continue;
    if (
      options.requirePermission &&
      !tool.permissions.includes("*") &&
      !tool.permissions.includes(options.requirePermission)
    ) {
      continue;
    }
    const haystack = `${tool.id} ${tool.name ?? ""} ${tool.description} ${tool.category}`.toLowerCase();
    const matched = tokens.filter((t) => haystack.includes(t));
    if (matched.length === 0) continue;
    results.push({
      ...tool,
      score: Math.round((matched.length / tokens.length) * 100) / 100,
      reason: `casa com: ${matched.slice(0, 4).join(", ")}`,
    });
  }
  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return results.slice(0, options.limit ?? 5);
}

export function seedBrainTools(db: DatabaseSync): number {
  const brainTools: RegisterToolInput[] = [
    { id: "brain_search", description: "Busca lexical no vault indexado", category: "search", permissions: ["READ"] },
    { id: "brain_context", description: "Contexto consolidado para tarefas", category: "context", permissions: ["READ"] },
    { id: "brain_related", description: "Grafo de entidades relacionadas", category: "graph", permissions: ["READ"] },
    { id: "brain_remember", description: "Registra memorias", category: "memory", permissions: ["READ", "WRITE"] },
    { id: "brain_timeline", description: "Historico de entidade", category: "graph", permissions: ["READ"] },
    { id: "brain_get", description: "Entidade especifica", category: "database", permissions: ["READ"] },
    { id: "brain_resolve", description: "Resolve nome para entidade", category: "search", permissions: ["READ"] },
    { id: "brain_sources", description: "Provenance de informacoes", category: "search", permissions: ["READ"] },
    { id: "brain_link", description: "Cria relacoes entre entidades", category: "graph", permissions: ["READ", "WRITE"] },
    { id: "brain_health", description: "Diagnostico do cerebro", category: "automation", permissions: ["READ"] },
  ];
  for (const t of brainTools) registerTool(db, { ...t, origin: "mcp" });
  return brainTools.length;
}
