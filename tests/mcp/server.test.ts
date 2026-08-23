import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import type { BrainConfig } from "../../core/config/loader.ts";
import { createBrainMcpServer, TOOL_NAMES } from "../../mcp/src/server.ts";

let dir: string;
let vault: string;
let config: BrainConfig;
let savedEnv: Record<string, string | undefined>;
let client: Client;

type ToolResult = {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
};

async function callTool(name: string, args: Record<string, unknown> = {}): Promise<{
  isError: boolean;
  data: any;
}> {
  const result = (await client.callTool({ name, arguments: args })) as unknown as ToolResult;
  const text = result.content?.[0]?.text ?? "{}";
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  return { isError: result.isError === true, data };
}

beforeAll(async () => {
  savedEnv = {
    SECOND_BRAIN_VAULT: process.env.SECOND_BRAIN_VAULT,
    SECOND_BRAIN_DATA_DIR: process.env.SECOND_BRAIN_DATA_DIR,
    SECOND_BRAIN_LOG_LEVEL: process.env.SECOND_BRAIN_LOG_LEVEL,
  };
  dir = mkdtempSync(path.join(tmpdir(), "brain-mcp-"));
  vault = path.join(dir, "vault");
  mkdirSync(vault, { recursive: true });
  process.env.SECOND_BRAIN_VAULT = vault;
  process.env.SECOND_BRAIN_DATA_DIR = dir;
  process.env.SECOND_BRAIN_LOG_LEVEL = "error";

  config = {
    vaultPath: vault,
    dataDir: dir,
    dbPath: path.join(dir, "brain.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };

  write(
    "01 - Projects/vyntra.md",
    `---
id: project.vyntra
type: project
title: Vyntra
status: active
aliases: [Vyntra CRM]
relations:
  - type: USES
    target: system.whatsapp-automation
---
# Vyntra
Plataforma de vendas com campanhas via [[system.whatsapp-automation|WhatsApp]].`,
  );
  write(
    "03 - Knowledge/whatsapp.md",
    `---
id: system.whatsapp-automation
type: system
title: WhatsApp Automation
---
Automacao de mensagens.`,
  );
  indexVault(config);

  const server = createBrainMcpServer();
  client = new Client({ name: "test-client", version: "0.1.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(dir, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const abs = path.join(vault, relPath.split("/").join(path.sep));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

describe("mcp server", () => {
  it("exposes exactly the 10 planned tools", async () => {
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([...TOOL_NAMES].sort());
  });

  it("brain_search returns hits with score and snippet", async () => {
    const { isError, data } = await callTool("brain_search", { query: "vendas whatsapp" });
    expect(isError).toBe(false);
    expect(data.hits.length).toBeGreaterThan(0);
    expect(data.hits[0].documentId).toBe("project.vyntra");
    expect(typeof data.hits[0].score).toBe("number");
    expect(data.hits[0].snippet).toContain("[");
  });

  it("brain_search rejects empty query as tool error", async () => {
    const { isError, data } = await callTool("brain_search", { query: "" });
    expect(isError).toBe(true);
    expect(JSON.stringify(data)).toMatch(/VALIDATION_ERROR|empty/i);
  });

  it("brain_resolve finds by alias with candidates", async () => {
    const { isError, data } = await callTool("brain_resolve", { query: "Vyntra CRM" });
    expect(isError).toBe(false);
    expect(data.best.method).toBe("alias");
    expect(data.best.entity.id).toBe("project.vyntra");
  });

  it("brain_get returns entity and stats; errors on unknown", async () => {
    const ok = await callTool("brain_get", { id: "system.whatsapp-automation" });
    expect(ok.isError).toBe(false);
    expect(ok.data.entity.canonicalName).toBe("WhatsApp Automation");
    expect(ok.data.stats.outgoingRelations).toBeGreaterThanOrEqual(0);

    const missing = await callTool("brain_get", { id: "project.nao-existe" });
    expect(missing.isError).toBe(true);
    expect(missing.data.code).toBe("NOT_FOUND");
  });

  it("brain_related returns typed edges and supports depth", async () => {
    const d1 = await callTool("brain_related", { id: "vyntra" });
    expect(d1.isError).toBe(false);
    expect(d1.data.start).toBe("project.vyntra");

    const d2 = await callTool("brain_related", { id: "vyntra", depth: 3 });
    const nodeIds = d2.data.nodes.map((n: { id: string }) => n.id);
    expect(nodeIds).toContain("system.whatsapp-automation");
  });

  it("brain_context builds consolidated context within budget", async () => {
    const { isError, data } = await callTool("brain_context", {
      subject: "Vyntra",
      task: "adicionar funcionalidade",
      maxChars: 3000,
    });
    expect(isError).toBe(false);
    expect(data.entityId).toBe("project.vyntra");
    expect(data.relatedEntities.length).toBeGreaterThan(0);
    expect(data.charBudget.used).toBeLessThanOrEqual(3000);
    expect(Array.isArray(data.warnings)).toBe(true);
  });

  it("brain_timeline lists entries for entity", async () => {
    const { isError, data } = await callTool("brain_timeline", { entityId: "vyntra" });
    expect(isError).toBe(false);
    expect(data.entityId).toBe("project.vyntra");
    expect(data.entries.length).toBeGreaterThan(0);
  });

  it("brain_sources shows provenance for entity and globally", async () => {
    const byEntity = await callTool("brain_sources", { entityId: "vyntra" });
    expect(byEntity.isError).toBe(false);
    expect(byEntity.data.originDocument.location).toContain("vyntra.md");

    const global = await callTool("brain_sources", {});
    expect(global.data.sources.some((s: { sourceType: string }) => s.sourceType === "obsidian")).toBe(true);
  });

  it("brain_remember persists memory linked to entity", async () => {
    const { isError, data } = await callTool("brain_remember", {
      content: "Usuario prefere TypeScript estrito no projeto Vyntra",
      memory_kind: "semantic",
      category: "PREFERENCE",
      entityId: "vyntra",
      confidence: 0.9,
    });
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.entityId).toBe("project.vyntra");

    const timeline = await callTool("brain_timeline", {
      entityId: "vyntra",
      kinds: ["memory"],
    });
    const memoryEntries = timeline.data.entries.filter(
      (e: { kind: string }) => e.kind === "memory",
    );
    expect(memoryEntries.length).toBeGreaterThan(0);

    const invalid = await callTool("brain_remember", {
      content: "x",
      memory_kind: "telepatico",
    });
    expect(invalid.isError).toBe(true);
    const signal = JSON.stringify(invalid.data).toLowerCase();
    expect(signal).toMatch(/invalid|telepatico|enum/);
  });

  it("brain_link creates conversation-sourced relation visible in graph", async () => {
    const link = await callTool("brain_link", {
      sourceEntity: "vyntra",
      targetEntity: "whatsapp",
      relationType: "depends_on",
      confidence: 0.7,
    });
    expect(link.isError).toBe(false);
    expect(link.data.relationType).toBe("DEPENDS_ON");

    const related = await callTool("brain_related", {
      id: "vyntra",
      direction: "out",
      relationTypes: ["DEPENDS_ON"],
    });
    expect(related.data.edges).toHaveLength(1);
    expect(related.data.edges[0].target).toBe("system.whatsapp-automation");
  });

  it("brain_link fails cleanly for unknown entities without partial writes", async () => {
    const before = await callTool("brain_health");
    const fail = await callTool("brain_link", {
      sourceEntity: "vyntra",
      targetEntity: "fantasma.inexistente",
      relationType: "USES",
    });
    expect(fail.isError).toBe(true);
    expect(fail.data.code).toBe("NOT_FOUND");

    const after = await callTool("brain_health");
    expect(after.data.counts.relations).toBe(before.data.counts.relations);
  });

  it("brain_health reports counts and schema version", async () => {
    const { isError, data } = await callTool("brain_health");
    expect(isError).toBe(false);
    expect(data.ok).toBe(true);
    expect(data.counts.documents).toBeGreaterThanOrEqual(2);
    expect(data.counts.entities).toBeGreaterThanOrEqual(2);
    expect(data.schemaVersion).toBeGreaterThanOrEqual(2);
    expect(data.vaultExists).toBe(true);
  });
});
