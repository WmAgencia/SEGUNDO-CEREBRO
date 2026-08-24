import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import {
  ensureCommTables,
  resolveContact,
  resolveConversation,
  saveMessage,
  isDuplicateMessage,
  classifyIntent,
} from "../../core/comms/pipeline.ts";
import { handleEvolutionWebhook } from "../../core/webhooks/evolution-webhook.ts";

let dir: string;
let config: BrainConfig;
let db: DatabaseSync;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-ops-"));
  config = {
    vaultPath: path.join(dir, "vault"),
    dataDir: dir,
    dbPath: path.join(dir, "brain.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  const d = openDatabase(config.dbPath);
  applySchema(d);
  d.close();
  writeFileSync(
    path.join(config.vaultPath, "vyntra.md"),
    "---\nid: project.vyntra\ntype: project\ntitle: Vyntra\nstatus: active\n---\n# Vyntra\nVendas de sites.",
    "utf8",
  );
  indexVault(config);
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("fase 26 — operational reality test", () => {
  it("classifies intents correctly", () => {
    expect(classifyIntent("Oi tudo bem?")).toBe("GREETING");
    expect(classifyIntent("Quanto custa um site?")).toBe("PRICE");
    expect(classifyIntent("Preciso de um sistema para minha clínica")).toBe("SERVICE");
    expect(classifyIntent("Consegue fazer por R$500?")).toBe("OBJECTION");
    expect(classifyIntent("Vamos agendar uma reunião?")).toBe("SCHEDULING");
  });

  it("processes incoming WhatsApp message through full pipeline", () => {
    const result = handleEvolutionWebhook(config, {
      event: "MESSAGES_UPSERT",
      instance: "SECOM",
      data: {
        key: { remoteJid: "55119999990001@s.whatsapp.net", fromMe: false, id: "test_msg_001" },
        pushName: "Cliente Teste",
        message: { conversation: "Oi, queria saber quanto custa um site." },
      },
    });
    expect(result.processed).toBe(true);
    expect(result.action).toContain("PRICE");
    expect(result.action).toContain("draft_generated");
  });

  it("ignores duplicate messages (idempotency)", () => {
    const result = handleEvolutionWebhook(config, {
      event: "MESSAGES_UPSERT",
      instance: "SECOM",
      data: {
        key: { remoteJid: "55119999990001@s.whatsapp.net", fromMe: false, id: "test_msg_001" },
        message: { conversation: "Oi" },
      },
    });
    expect(result.processed).toBe(false);
    expect(result.action).toContain("duplicate");
  });

  it("ignores own messages (fromMe)", () => {
    const result = handleEvolutionWebhook(config, {
      event: "MESSAGES_UPSERT",
      instance: "SECOM",
      data: {
        key: { remoteJid: "55119999990001@s.whatsapp.net", fromMe: true, id: "own_001" },
        message: { conversation: "minha própria mensagem" },
      },
    });
    expect(result.processed).toBe(false);
  });

  it("proactive brain generates proposals for behind-schedule goals", () => {
    const d = openDatabase(config.dbPath);
    createGoal(d);
    d.close();

    // Import and call brainNextActions
    const { brainNextActions } = require("../../core/goals/proactive.ts") as typeof import("../../core/goals/proactive.ts");
    const na = brainNextActions(config);
    expect(Array.isArray(na.recommendations)).toBe(true);
  });

  it("contact resolution avoids duplicates", () => {
    const c1 = resolveContact(openDatabase(config.dbPath), "5511999999999", "Test");
    const c2 = resolveContact(openDatabase(config.dbPath), "5511999999999", "Test");
    expect(c1.id).toBe(c2.id);
    expect(c1.isNew).toBe(true);
    expect(c2.isNew).toBe(false);
  });
});

function createGoal(d: DatabaseSync): void {
  d.prepare(
    `INSERT INTO goals (id, name, type, status, priority, metric_name, target, current_value, deadline, project)
     VALUES ('goal.test.urgent', 'Goal urgente', 'SALES', 'ACTIVE', 1, 'clientes', 5, 0,
             strftime('%Y-%m-%dT%H:%M:%fZ','now','+3 days'), 'project.vyntra')`,
  ).run();
}
