import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import type { BrainConfig } from "../../core/config/loader.ts";
import {
  agentContext,
  getAgent,
  listAgents,
  upsertAgent,
} from "../../core/agents/agent-runtime.ts";

let dir: string;
let config: BrainConfig;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-agent-"));
  config = {
    vaultPath: path.join(dir, "vault"),
    dataDir: dir,
    dbPath: path.join(dir, "brain.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  writeFileSync(
    path.join(config.vaultPath, "vyntra.md"),
    "---\nid: project.vyntra\ntype: project\ntitle: Vyntra\nstatus: active\n---\n# Vyntra\nVendas.",
    "utf8",
  );
  indexVault(config);
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("agent runtime (fase 11)", () => {
  it("registers an agent with capabilities and permissions", () => {
    const db = new DatabaseSync(config.dbPath);
    db.close();
    const db2 = openDb();
    const agent = upsertAgent(db2, {
      id: "research-agent",
      name: "Research Agent",
      description: "Pesquisa e analise",
      domains: ["research", "vendas"],
      capabilities: ["search", "summarize"],
      permissions: ["context", "memory.read"],
      status: "active",
    });
    db2.close();
    expect(agent.id).toBe("research-agent");
    expect(agent.domains).toContain("vendas");

    const fetched = getAgent(openDb(), "research-agent");
    expect(fetched.capabilities).toContain("summarize");
    expect(listAgents(openDb()).length).toBeGreaterThanOrEqual(1);
  });

  it("returns context package for authorized agent", () => {
    const pkg = agentContext(config, {
      agentId: "research-agent",
      task: "analisar o projeto vyntra",
    });
    expect(pkg.agent.id).toBe("research-agent");
    expect(pkg.entities).toContain("project.vyntra");
  });

  it("denies context to agent without permission and rejects invalid ids", () => {
    const db = openDb();
    upsertAgent(db, {
      id: "locked-agent",
      name: "Locked",
      description: "",
      permissions: ["none"],
      status: "active",
    });
    upsertAgent(db, {
      id: "paused-agent",
      name: "Paused",
      description: "",
      permissions: ["context"],
      status: "paused",
    });
    db.close();

    expect(() =>
      agentContext(config, { agentId: "locked-agent", task: "x" }),
    ).toThrowError(/lacks permission/i);
    expect(() =>
      agentContext(config, { agentId: "paused-agent", task: "x" }),
    ).toThrowError(/is paused/i);
    expect(() =>
      upsertAgent(openDb(), { id: "Bad_ID", name: "x" }),
    ).toThrowError(/kebab-case/i);
    expect(() => getAgent(openDb(), "ghost")).toThrowError(/not found/i);
  });
});

function openDb() {
  return new DatabaseSync(config.dbPath);
}
