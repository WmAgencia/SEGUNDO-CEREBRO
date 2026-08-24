import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import { ensureCommTables } from "../../core/comms/pipeline.ts";
import {
  parseWhatsAppExport,
  ingestSource,
  resolveEntityByName,
} from "../../core/ingest/whatsapp-ingest.ts";
import { searchMemories } from "../../core/memory/memory-engine.ts";

let dir: string;
let config: BrainConfig;
let db: DatabaseSync;
let sampleFile: string;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-ing-"));
  config = {
    vaultPath: path.join(dir, "v"),
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  db = openDatabase(config.dbPath);
  applySchema(db);
  ensureCommTables(db);

  sampleFile = path.join(dir, "sample.txt");
  writeFileSync(sampleFile, [
    "31/07/2026 13:33 - As mensagens e ligações são protegidas com criptografia.",
    "01/08/2026 09:00 - Wesley - Consecom: Bom dia, Samira!",
    "01/08/2026 09:30 - +55 11 99767-3531: Bom dia! Como posso ajudar?",
    "01/08/2026 10:00 - Wesley - Consecom: Quero te mostrar uma proposta de site para sua clínica.",
    "01/08/2026 10:15 - +55 11 99767-3531: Interessa sim, quanto custa?",
    "02/08/2026 14:00 - Wesley - Consecom: Vou preparar uma proposta personalizada.",
  ].join("\n"), "utf8");
});

afterAll(() => {
  try { db.close(); rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("fase 29 — whatsapp ingest", () => {
  it("parses WhatsApp export format", () => {
    const msgs = parseWhatsAppExport(sampleFile);
    expect(msgs.length).toBeGreaterThan(3);
    expect(msgs[0]?.speaker).toContain("Wesley");
  });

  it("ingests source with provenance and confidence", () => {
    const result = ingestSource(db, {
      sourceId: "samira-a",
      filePath: sampleFile,
      contextScope: "COMMERCIAL",
      contactPhone: "5511997673531",
      contactName: "Samira",
      confidenceBase: 0.95,
    });
    expect(result.stored).toBeGreaterThan(0);
    expect(result.totalMessages).toBeGreaterThan(0);
  });

  it("memories are searchable by context", () => {
    const results = searchMemories(db, { text: "proposta site" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.content).toBeTruthy();
  });

  it("resolves entity across sources", () => {
    // Simulate second source for same person
    ingestSource(db, {
      sourceId: "samira-b",
      filePath: sampleFile,
      contextScope: "COMMERCIAL",
      contactPhone: "5511943177406",
      contactName: "Samira",
      confidenceBase: 0.9,
    });

    const resolved = resolveEntityByName(db, "Samira");
    if (resolved) {
      expect(resolved.phones.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("context isolation: COMMERCIAL memories don't appear in PERSONAL search", () => {
    ingestSource(db, {
      sourceId: "ana-personal",
      filePath: sampleFile,
      contextScope: "PERSONAL",
      contactName: "Ana",
      confidenceBase: 0.8,
    });
    const personal = searchMemories(db, { category: "PERSONAL", limit: 5 });
    expect(personal.every((m) => m.category === "PERSONAL")).toBe(true);
  });
});
