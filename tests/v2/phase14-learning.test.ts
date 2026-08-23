import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import {
  acceptObservation,
  listCandidates,
  observe,
  rejectObservation,
} from "../../core/learning/learning-loop.ts";
import { createMemory } from "../../core/memory/memory-engine.ts";

let dir: string;
let config: BrainConfig;
let db: DatabaseSync;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-learn-"));
  config = {
    vaultPath: path.join(dir, "v"),
    dataDir: dir,
    dbPath: path.join(dir, "b.db"),
    logLevel: "error",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 },
    ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };
  mkdirSync(config.vaultPath, { recursive: true });
  db = openDatabase(config.dbPath);
  applySchema(db);
});

afterAll(() => {
  try {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  } catch {}
});

describe("learning loop (fase 14)", () => {
  it("aggregates repeated corrections into a candidate", () => {
    const r1 = observe(db, {
      observationType: "user_correction",
      subject: "Sempre usar TypeScript estrito no Vyntra",
      patternKey: "correcao ts strict vyntra",
      payload: { projeto: "vyntra" },
      threshold: 3,
    });
    expect(r1.count).toBe(1);
    expect(r1.isCandidate).toBe(false);

    observe(db, {
      observationType: "user_correction",
      subject: "use strict TS no vyntra!",
      patternKey: "correcao ts strict vyntra",
      threshold: 3,
    });
    const r3 = observe(db, {
      observationType: "user_correction",
      subject: "TYPESCRIPT STRICT no VYNTRA",
      patternKey: "correcao ts strict vyntra",
      threshold: 3,
    });
    expect(r3.count).toBe(3);
    expect(r3.isCandidate).toBe(true);

    const candidates = listCandidates(db);
    expect(candidates.some((c) => c.id === r3.id && c.status === "candidate")).toBe(true);
  });

  it("accept promotes to semantic memory (governance)", () => {
    const candidate = listCandidates(db).find(
      (c) => c.observationType === "user_correction" && c.status === "candidate",
    );
    if (!candidate) throw new Error("candidate missing");

    const accepted = acceptObservation(db, candidate.id);
    expect(accepted.status).toBe("accepted");

    const mem = createMemory(db, {
      content: `Preferencia aprendida: ${candidate.subject}`,
      memoryKind: "semantic",
      category: "PREFERENCE",
      confidence: 0.85,
    });
    expect(mem.importance).toBeGreaterThan(0);

    const rejected = rejectObservation(db, candidate.id);
    expect(rejected.status).toBe("rejected");
  });

  it("different patterns stay separate; invalid input rejected", () => {
    const a = observe(db, { observationType: "error", subject: "timeout na api", threshold: 5 });
    const b = observe(db, { observationType: "preference", subject: "timeout na api", threshold: 5 });
    expect(a.patternKey).not.toBe(b.patternKey);
    expect(a.isCandidate).toBe(false);
    expect(() => observe(db, { observationType: "", subject: "x" })).toThrowError(/required/i);
    expect(() => rejectObservation(db, 99999)).toThrowError(/not found/i);
  });
});
