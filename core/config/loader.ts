import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigError } from "../errors/errors.ts";
import type { LogLevel } from "../logger/logger.ts";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function findProjectRoot(startDir: string = MODULE_DIR): string {
  let dir = startDir;
  while (true) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new ConfigError("project root not found (no package.json upward)");
    }
    dir = parent;
  }
}

export interface SearchConfig {
  defaultLimit: number;
  maxLimit: number;
}

export interface ContextConfig {
  maxChars: number;
  defaultDepth: number;
  maxDepth: number;
}

export interface AIConfig {
  baseUrl: string;
  model: string;
}

export interface BrainConfig {
  vaultPath: string;
  dataDir: string;
  dbPath: string;
  logLevel: LogLevel;
  search: SearchConfig;
  context: ContextConfig;
  ai: AIConfig;
}

interface DefaultConfigFile {
  vaultPath: string | null;
  dataDir: string;
  dbName: string;
  logLevel: string;
  search: Partial<SearchConfig>;
  context: Partial<ContextConfig>;
  ai?: Partial<AIConfig>;
}

function readDefaults(projectRoot: string): DefaultConfigFile {
  const configPath = path.join(projectRoot, "config", "default.json");
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as DefaultConfigFile;
  } catch (err) {
    throw new ConfigError(`failed to read ${configPath}`, {
      cause: err instanceof Error ? err.message : String(err),
    });
  }
}

function toLogLevel(raw: string | undefined, fallback: LogLevel): LogLevel {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = raw.toLowerCase();
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  throw new ConfigError(`invalid log level "${raw}"`, { allowed: ["debug", "info", "warn", "error"] });
}

export function loadConfig(options?: { projectRoot?: string }): BrainConfig {
  const projectRoot = options?.projectRoot ?? findProjectRoot();
  const defaults = readDefaults(projectRoot);

  const envVault = process.env.SECOND_BRAIN_VAULT;
  const vaultPath = envVault && envVault.trim() !== "" ? path.resolve(envVault) : defaults.vaultPath;

  if (!vaultPath) {
    throw new ConfigError(
      "vault path not configured. Set SECOND_BRAIN_VAULT to your Obsidian vault directory.",
    );
  }

  const envDataDir = process.env.SECOND_BRAIN_DATA_DIR;
  const rawDataDir = envDataDir && envDataDir.trim() !== "" ? envDataDir : defaults.dataDir;
  const dataDir = path.isAbsolute(rawDataDir) ? rawDataDir : path.join(projectRoot, rawDataDir);

  return {
    vaultPath,
    dataDir,
    dbPath: path.join(dataDir, defaults.dbName),
    logLevel: toLogLevel(process.env.SECOND_BRAIN_LOG_LEVEL, toLogLevel(defaults.logLevel, "info")),
    search: {
      defaultLimit: defaults.search.defaultLimit ?? 10,
      maxLimit: defaults.search.maxLimit ?? 50,
    },
    context: {
      maxChars: defaults.context.maxChars ?? 12000,
      defaultDepth: defaults.context.defaultDepth ?? 1,
      maxDepth: defaults.context.maxDepth ?? 3,
    },
    ai: {
      baseUrl: defaults.ai?.baseUrl ?? "http://127.0.0.1:11434",
      model: process.env.SECOND_BRAIN_AI_MODEL ?? defaults.ai?.model ?? "qwen3-1.7b",
    },
  };
}
