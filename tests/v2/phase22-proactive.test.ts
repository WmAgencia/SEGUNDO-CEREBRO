import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import {
  createGoal,
  updateGoal,
} from "../../core/goals/goal-engine.ts";
import {
  addObservation,
} from "../../core/goals/funnel.ts";
import {
  generateProactiveProposals,
  generateDailyDigest,
} from "../../core/proactive/proactive-engine.ts";

let dir: string;
let config: BrainConfig;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-pro-"));
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
  const d = openDatabase(config.dbPath);
  applySchema(d);
  createGoal(d, {
    name: "Vender sites urgentemente",
    type: "SALES",
    status: "ACTIVE",
    priority: 1,
    metricName: "clientes",
    target: 5,
    currentValue: 1,
    projectId: "project.vyntra",
    deadline: new Date(Date.now() + 3 * 86400000).toISOString(),
  });
  addObservation(d, {
    type: "OPPORTUNITY_SIGNAL",
    projectId: "project.vyntra",
    data: { title: "Clínicas sem presença digital" },
    confidence: 0.8,
    importance: 0.9,
  });
  d.close();
});

afterAll(() => {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
});

describe("proactive brain (fase 22)", () => {
  it("generates proposals for behind-schedule goals", () => {
    const proposals = generateProactiveProposals(config);
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.some((p) => p.priority === "URGENT")).toBe(true);
    expect(proposals.some((p) => p.reason.includes("prazo"))).toBe(true);
  });

  it("detects opportunity signals", () => {
    const proposals = generateProactiveProposals(config);
    expect(proposals.some((p) => p.title.includes("Clínicas"))).toBe(true);
  });

  it("daily digest aggregates counts", () => {
    const digest = generateDailyDigest(config);
    expect(digest.goals.length).toBeGreaterThan(0);
    expect(typeof digest.opportunities).toBe('number');
    expect(Array.isArray(digest.recommendations)).toBe(true);
  });
});
