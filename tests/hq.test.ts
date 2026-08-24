import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { executeHqCommand, getHqSnapshot } from "../core/hq/hq-api.ts";
import type { BrainConfig } from "../core/config/loader.ts";

let directory = "";
afterEach(() => { if (directory) rmSync(directory, { recursive: true, force: true }); directory = ""; });

function config(): BrainConfig {
  directory = mkdtempSync(path.join(tmpdir(), "second-brain-hq-"));
  const vaultPath = path.join(directory, "vault"); mkdirSync(vaultPath);
  return { vaultPath, dataDir: directory, dbPath: path.join(directory, "brain.db"), logLevel: "error", search: { defaultLimit: 10, maxLimit: 50 }, context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3" } };
}

describe("Second Brain HQ integration", () => {
  it("consome estado real e cria goal com confirmação", () => {
    const cfg = config(); const db = openDatabase(cfg.dbPath); applySchema(db); db.close();
    const snapshot = getHqSnapshot(cfg);
    expect(snapshot.office.departments.length).toBeGreaterThanOrEqual(6);
    expect(snapshot.agents.find((a) => String(a.id) === "manager")).toBeTruthy();
    expect(snapshot.office.bounds.w).toBeGreaterThan(0);
    const result = executeHqCommand(cfg, "Quero criar um objetivo de desenvolvimento do Nutriva.", "hq-test");
    expect(result.ok).toBe(true);
    expect(result.requiresConfirmation ?? result.type === "plan").toBeTruthy();
  });
});
