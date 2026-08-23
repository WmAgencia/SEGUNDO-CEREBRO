export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

let currentLevel: LogLevel = resolveInitialLevel();

function resolveInitialLevel(): LogLevel {
  const raw = process.env.SECOND_BRAIN_LOG_LEVEL?.toLowerCase();
  if (raw === "debug" || raw === "info" || raw === "warn" || raw === "error") {
    return raw;
  }
  return "info";
}

function enabled(level: LogLevel): boolean {
  return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[currentLevel];
}

function emit(level: LogLevel, scope: string, message: string, data?: unknown): void {
  if (!enabled(level)) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    scope,
    msg: message,
    ...(data !== undefined ? { data } : {}),
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
  child(scope: string): Logger;
}

export function createLogger(scope = "brain"): Logger {
  return {
    debug: (m, d) => emit("debug", scope, m, d),
    info: (m, d) => emit("info", scope, m, d),
    warn: (m, d) => emit("warn", scope, m, d),
    error: (m, d) => emit("error", scope, m, d),
    child: (childScope: string) => createLogger(`${scope}:${childScope}`),
  };
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}
