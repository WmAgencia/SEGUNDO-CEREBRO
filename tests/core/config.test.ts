import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  findProjectRoot,
  loadConfig,
} from "../../core/config/loader.ts";

const ENV_KEYS = ["SECOND_BRAIN_VAULT", "SECOND_BRAIN_DATA_DIR", "SECOND_BRAIN_LOG_LEVEL"] as const;

function saveEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
}

describe("core/config", () => {
  let dir: string;
  let vault: string;
  let saved: Record<string, string | undefined>;

  beforeAll(() => {
    saved = saveEnv();
    for (const key of ENV_KEYS) delete process.env[key];
    dir = mkdtempSync(path.join(tmpdir(), "brain-config-"));
    vault = path.join(dir, "vault");
    mkdirSync(vault, { recursive: true });
  });

  afterAll(() => {
    restoreEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  });

  it("finds project root from nested module dir", () => {
    const root = findProjectRoot();
    expect(path.basename(root)).toBe("second-brain");
  });

  it("throws ConfigError when vault is not configured", () => {
    expect(() => loadConfig()).toThrowError(/SECOND_BRAIN_VAULT/);
  });

  it("loads defaults with env vault only", () => {
    process.env.SECOND_BRAIN_VAULT = vault;
    const config = loadConfig();
    expect(config.vaultPath).toBe(vault);
    expect(path.basename(config.dbPath)).toBe("brain.db");
    expect(config.search.defaultLimit).toBe(10);
  });

  it("env overrides data dir and log level", () => {
    process.env.SECOND_BRAIN_VAULT = vault;
    process.env.SECOND_BRAIN_DATA_DIR = path.join(dir, "custom-data");
    process.env.SECOND_BRAIN_LOG_LEVEL = "debug";
    const config = loadConfig();
    expect(config.dataDir).toContain("custom-data");
    expect(config.dbPath).toBe(path.join(config.dataDir, "brain.db"));
    expect(config.logLevel).toBe("debug");
  });

  it("relative SECOND_BRAIN_VAULT resolves to absolute", () => {
    process.env.SECOND_BRAIN_VAULT = "some-relative-vault";
    const config = loadConfig();
    expect(path.isAbsolute(config.vaultPath)).toBe(true);
  });

  it("rejects invalid log level", () => {
    process.env.SECOND_BRAIN_LOG_LEVEL = "loud";
    expect(() => loadConfig()).toThrowError(/invalid log level/);
    process.env.SECOND_BRAIN_LOG_LEVEL = undefined;
  });
});
