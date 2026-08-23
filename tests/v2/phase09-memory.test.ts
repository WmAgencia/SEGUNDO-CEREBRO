import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import {
  clearExpiredWorkingMemory,
  computeImportance,
  createMemory,
  getMemory,
  getWorkingMemory,
  relatedMemories,
  searchMemories,
  setWorkingMemory,
  updateMemoryImportance,
} from "../../core/memory/memory-engine.ts";

let dir: string;
let config: BrainConfig;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-mem-"));
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
});

afterAll(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows pode manter handle do WAL por alguns instantes
  }
});

describe("memory engine (fase 9)", () => {
  it("creates memory with computed importance and searchable via fts", () => {
    const db = openDatabase(config.dbPath);
    applySchema(db);
    db.prepare(
      "INSERT OR IGNORE INTO entities (id, canonical_name, type) VALUES ('project.vyntra', 'Vyntra', 'project'), ('user.local', 'Usuario', 'person')",
    ).run();
    const m = createMemory(db, {
      content: "Vyntra é um sistema de prospecção e vendas",
      memoryKind: "semantic",
      category: "FACT",
      entityId: "project.vyntra",
      projectId: "project.vyntra",
      confidence: 0.9,
    });
    expect(m.importance).toBeGreaterThanOrEqual(0.9);

    const hits = searchMemories(db, { text: "prospecção" });
    expect(hits.some((h) => h.id === m.id)).toBe(true);
    db.close();
  });

  it("filters by entity/project/kind/importance/period", () => {
    const db = openDatabase(config.dbPath);
    createMemory(db, {
      content: "Decidido adiar integração das skills",
      memoryKind: "episodic",
      category: "DECISION",
      entityId: "project.vyntra",
      confidence: 0.8,
    });
    createMemory(db, {
      content: "Preferência por respostas curtas",
      memoryKind: "semantic",
      category: "PREFERENCE",
      entityId: "user.local",
      confidence: 0.7,
      importance: 0.2,
    });

    const byEntity = searchMemories(db, { entityId: "project.vyntra" });
    expect(byEntity.length).toBeGreaterThanOrEqual(2);
    expect(byEntity.every((m) => m.entityId === "project.vyntra")).toBe(true);

    const byKind = searchMemories(db, { kind: "episodic" });
    expect(byKind.every((m) => m.memoryKind === "episodic")).toBe(true);

    const byImportance = searchMemories(db, { minImportance: 0.8 });
    expect(byImportance.every((m) => m.importance >= 0.8)).toBe(true);

    const byPeriod = searchMemories(db, {
      from: new Date(Date.now() + 86400000).toISOString(),
    });
    expect(byPeriod).toHaveLength(0);
    db.close();
  });

  it("get increments access count; importance update works", () => {
    const db = openDatabase(config.dbPath);
    const m = createMemory(db, { content: "fato acessivel", confidence: 0.6 });
    const g1 = getMemory(db, m.id);
    const g2 = getMemory(db, m.id);
    expect(g2.accessCount).toBeGreaterThan(g1.accessCount - 1);
    const updated = updateMemoryImportance(db, m.id, 1);
    expect(updated?.importance).toBeGreaterThanOrEqual(0.9);
    db.close();
  });

  it("related memories by entity", () => {
    const db = openDatabase(config.dbPath);
    const rel = relatedMemories(db, "project.vyntra", 5);
    expect(rel.length).toBeGreaterThan(0);
    db.close();
  });

  it("working memory expires", () => {
    const db = openDatabase(config.dbPath);
    setWorkingMemory(db, "task:vyntra-refactor", { projeto: "vyntra" }, 60);
    expect(getWorkingMemory(db, "task:vyntra-refactor")).toMatchObject({
      projeto: "vyntra",
    });
    db.prepare(
      "UPDATE working_memory SET expires_at = '2000-01-01T00:00:00Z' WHERE task_key = ?",
    ).run("task:vyntra-refactor");
    expect(getWorkingMemory(db, "task:vyntra-refactor")).toBeNull();
    expect(clearExpiredWorkingMemory(db)).toBe(0);
    db.close();
  });

  it("computeImportance is deterministic and bounded", () => {
    const high = computeImportance({ explicit: 1, accessCount: 10, linkedToProject: true });
    const low = computeImportance({ confidence: 0.3 });
    expect(high).toBeLessThanOrEqual(1);
    expect(low).toBeLessThan(high);
    expect(computeImportance({ explicit: 1 })).toBe(computeImportance({ explicit: 1 }));
  });
});
