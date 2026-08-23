import { DatabaseSync } from "node:sqlite";
import { NotFoundError, ValidationError } from "../errors/errors.ts";
import type { BrainConfig } from "../config/loader.ts";
import { buildContextPackage } from "../context/context-package.ts";
import type { ContextPackage } from "../context/context-package.ts";

export interface AgentRecord {
  id: string;
  name: string;
  description: string;
  domains: string[];
  capabilities: string[];
  permissions: string[];
  status: string;
}

interface RawAgent {
  id: string;
  name: string;
  description: string;
  domains: string;
  capabilities: string;
  permissions: string;
  status: string;
}

function parseList(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string")
      : [];
  } catch {
    return [];
  }
}

function toAgent(r: RawAgent): AgentRecord {
  return {
    id: r.id,
    name: r.name,
    description: r.description,
    domains: parseList(r.domains),
    capabilities: parseList(r.capabilities),
    permissions: parseList(r.permissions),
    status: r.status,
  };
}

export interface UpsertAgentInput {
  id: string;
  name: string;
  description?: string;
  domains?: string[];
  capabilities?: string[];
  permissions?: string[];
  status?: string;
}

export function upsertAgent(
  db: DatabaseSync,
  input: UpsertAgentInput,
): AgentRecord {
  if (!input.id.match(/^[a-z0-9-]+$/)) {
    throw new ValidationError("agent id deve ser kebab-case");
  }
  db.prepare(
    `INSERT INTO agents (id, name, description, domains, capabilities, permissions, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       description = excluded.description,
       domains = excluded.domains,
       capabilities = excluded.capabilities,
       permissions = excluded.permissions,
       status = excluded.status`,
  ).run(
    input.id,
    input.name,
    input.description ?? "",
    JSON.stringify(input.domains ?? []),
    JSON.stringify(input.capabilities ?? []),
    JSON.stringify(input.permissions ?? ["context"]),
    input.status ?? "active",
  );
  return getAgent(db, input.id);
}

export function getAgent(db: DatabaseSync, id: string): AgentRecord {
  const row = db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as
    | RawAgent
    | undefined;
  if (!row) throw new NotFoundError(`agent not found: ${id}`);
  return toAgent(row);
}

export function listAgents(db: DatabaseSync): AgentRecord[] {
  const rows = db
    .prepare("SELECT * FROM agents ORDER BY id")
    .all() as unknown as RawAgent[];
  return rows.map(toAgent);
}

const CONTEXT_PERMISSION = "context";

export function agentContext(
  config: BrainConfig,
  args: { agentId: string; task: string; project?: string; entity?: string; depth?: number; maxChars?: number },
): ContextPackage & { agent: AgentRecord } {
  const db = new DatabaseSync(config.dbPath);
  let agent: AgentRecord;
  try {
    agent = getAgent(db, args.agentId);
  } finally {
    db.close();
  }

  if (agent.status !== "active") {
    throw new ValidationError(`agent "${agent.id}" is ${agent.status}`);
  }
  if (
    !agent.permissions.includes("*") &&
    !agent.permissions.includes(CONTEXT_PERMISSION)
  ) {
    throw new ValidationError(
      `agent "${agent.id}" lacks permission "${CONTEXT_PERMISSION}"`,
    );
  }

  const pkg = buildContextPackage(config, {
    task: args.task,
    project: args.project,
    entity: args.entity,
    depth: args.depth,
    maxChars: args.maxChars,
  });

  return { ...pkg, agent };
}
