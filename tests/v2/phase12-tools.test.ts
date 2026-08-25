import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../../core/config/loader.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";
import {
  registerTool,
  resolveTools,
  seedBrainTools,
  setToolAvailability,
} from "../../core/tools/tool-registry.ts";

let dir: string;
let config: BrainConfig;
let db: DatabaseSync;

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-tools-"));
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

describe("tool registry (fase 12)", () => {
  it("seeds brain tools and registers custom ones", () => {
    const n = seedBrainTools(db);
    expect(n).toBe(17);
    expect(listAll().length).toBe(17);

    registerTool(db, {
      id: "github_search_code",
      name: "GitHub Code Search",
      description: "Busca codigo em repositorios do github",
      category: "github",
      permissions: ["READ", "NETWORK"],
      origin: "mcp",
    });
    expect(listAll().length).toBe(18);
  });

  it("resolves tools by task with scoring", () => {
    const res = resolveTools(db, "preciso buscar codigo no github de um cliente");
    expect(res[0]?.id).toBe("github_search_code");
    expect(res[0]?.score).toBeGreaterThan(0);
    expect(res[0]?.reason).toContain("codigo");
  });

  it("filters by permission requirement", () => {
    const readOnly = resolveTools(db, "registrar memorias", {
      requirePermission: "READ",
      limit: 20,
    });
    expect(readOnly.length).toBeGreaterThan(0);
    const writeOnly = resolveTools(db, "registrar memorias", {
      requirePermission: "WRITE",
      limit: 20,
    });
    expect(writeOnly.every((t) => t.permissions.includes("WRITE"))).toBe(true);
  });

  it("unavailable tools are excluded from resolution", () => {
    setToolAvailability(db, "github_search_code", false);
    const res = resolveTools(db, "buscar codigo no github");
    expect(res.some((t) => t.id === "github_search_code")).toBe(false);
    setToolAvailability(db, "github_search_code", true);
  });
});

function listAll() {
  return db.prepare("SELECT id FROM tools_registry").all() as unknown as Array<{ id: string }>;
}
