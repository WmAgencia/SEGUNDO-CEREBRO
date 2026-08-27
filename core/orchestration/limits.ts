/** Orchestration limit knobs (env-configurable, conservative defaults). */
export function orchestrationLimits(): {
  maxParallel: number;
  maxRetries: number;
  maxIterations: number;
  staleAfterMs: number;
  opencodeTimeoutMs: number;
} {
  const num = (env: string, fallback: number): number => {
    const raw = process.env[env];
    if (!raw) return fallback;
    const v = Number(raw);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : fallback;
  };
  return {
    maxParallel: num("MAX_PARALLEL_NODES", 2),
    maxRetries: num("GRAPH_MAX_RETRIES", 2),
    maxIterations: num("GRAPH_MAX_ITERATIONS", 3),
    staleAfterMs: num("GRAPH_STALE_AFTER_MS", 30 * 60 * 1000),
    opencodeTimeoutMs: num("OPENCODE_TIMEOUT_MS", 300_000),
  };
}

export const MAX_PARALLEL_NODES = 2;