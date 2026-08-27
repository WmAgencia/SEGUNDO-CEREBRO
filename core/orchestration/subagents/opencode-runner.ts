/**
 * OpenCode Subagent Runner — REAL invocation of the native OpenCode CLI.
 *
 * Delegates a graph node to an OpenCode subagent:
 *   opencode run --agent <id> --format json "task"  (run in the project cwd)
 *
 * Uses OpenCode's native primitives (primary agents/subagents, `--agent`,
 * json output with session id). If the CLI is unavailable or the workspace is
 * invalid, the runner returns `unavailable` so the graph marks the node
 * BLOCKED (never a fake "success").
 *
 * Injectable so tests can fake the subagent (the executor/planner logic is
 * tested deterministically; the real CLI is exercised in the reality gate).
 */

import { spawn } from "node:child_process";
import type { BrainConfig } from "../../config/loader.ts";

// Subset of the actual OpenCodeSession shape we need.
// status matches OpenCodeRuntime.OpenCodeSession.status.
export type OpenCodeRunStatus = "COMPLETED" | "FAILED" | "BLOCKED";

export interface SubagentRunResult {
  ok: boolean;
  status: OpenCodeRunStatus;
  output: string;
  sessionId: string | null;
  filesChanged: string[];
  testsPassed: boolean | null;
  error: string | null;
  unavailable: boolean;
  durationMs: number;
}

export interface SubagentRunner {
  /** True when the real OpenCode CLI is reachable (cached per process). */
  isAvailable(): Promise<boolean>;
  run(opts: {
    agentId: string;
    task: string;
    cwd: string;
    model?: string;
    timeoutMs?: number;
    parentSessionId?: string;
  }): Promise<SubagentRunResult>;
}

export function resolveOpenCodeCommand(): string {
  const candidates =
    process.platform === "win32"
      ? ["node_modules/.bin/opencode.cmd", "opencode.cmd", "opencode"]
      : ["opencode"];
  return candidates[0] ?? "opencode";
}

let cachedAvailability: boolean | null = null;

export class OpenCodeSubagentRunner implements SubagentRunner {
  private command: string;
  constructor(command = resolveOpenCodeCommand()) {
    this.command = command;
  }

  async isAvailable(): Promise<boolean> {
    if (cachedAvailability !== null) return cachedAvailability;
    cachedAvailability = await new Promise<boolean>((resolve) => {
      let settled = false;
      const proc = spawn(this.command, ["--version"], { shell: process.platform === "win32", windowsHide: true });
      const timer = setTimeout(() => { if (!settled) { settled = true; proc.kill("SIGTERM"); resolve(false); } }, 5000);
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(code === 0);
      });
      proc.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      });
    });
    return cachedAvailability;
  }

  resetAvailability(): void {
    cachedAvailability = null;
  }

  validateWorkspace(cwd: string): boolean {
    const blocked = ["C:\\Windows", "C:\\Program Files", "/Windows", "/Program Files"];
    return !blocked.some((b) => cwd.startsWith(b));
  }

  async run(opts: {
    agentId: string;
    task: string;
    cwd: string;
    model?: string;
    timeoutMs?: number;
    parentSessionId?: string;
  }): Promise<SubagentRunResult> {
    const started = Date.now();
    if (!this.validateWorkspace(opts.cwd)) {
      return { ok: false, status: "BLOCKED", output: "", sessionId: null, filesChanged: [], testsPassed: false, error: `workspace inválido: ${opts.cwd}`, unavailable: true, durationMs: Date.now() - started };
    }
    const available = await this.isAvailable();
    if (!available) {
      return { ok: false, status: "BLOCKED", output: "", sessionId: null, filesChanged: [], testsPassed: false, error: "OpenCode CLI indisponível (não encontrado no ambiente)", unavailable: true, durationMs: Date.now() - started };
    }

    const args = ["run", "--format", "json", "--agent", opts.agentId];
    if (opts.model) args.push("--model", opts.model);
    if (opts.parentSessionId) args.push("--session", opts.parentSessionId);
    args.push(opts.task);

    return new Promise<SubagentRunResult>((resolve) => {
      let stdout = "";
      let stderr = "";
      let durationMs = Date.now() - started;
      const proc = spawn(this.command, args, {
        cwd: opts.cwd,
        shell: process.platform === "win32",
        windowsHide: true,
        env: process.env,
      });
      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({
          ok: false,
          status: "FAILED",
          output: redact(`${stdout}\n${stderr}`.slice(0, 4000)),
          sessionId: null,
          filesChanged: [],
          testsPassed: false,
          error: `timeout após ${opts.timeoutMs ?? 300000}ms`,
          unavailable: false,
          durationMs,
        });
      }, opts.timeoutMs ?? 300_000);

      proc.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        clearTimeout(timer);
        durationMs = Date.now() - started;
        if (code === 0) {
          const evt = parseLastTextEvent(stdout);
          resolve({
            ok: true,
            status: "COMPLETED",
            output: redact((evt ?? stdout).slice(0, 8000)),
            sessionId: extractSessionId(stdout) ?? null,
            filesChanged: extractFilesChanged(stdout),
            testsPassed: /passed|OK|success/i.test(`${stdout}\n${stderr}`),
            error: null,
            unavailable: false,
            durationMs,
          });
        } else {
          resolve({
            ok: false,
            status: "FAILED",
            output: redact(`${stdout}\n${stderr}`.slice(0, 4000)),
            sessionId: extractSessionId(stdout) ?? null,
            filesChanged: extractFilesChanged(stdout),
            testsPassed: false,
            error: redact(stderr.slice(0, 1000) || `exit code ${code}`),
            unavailable: false,
            durationMs,
          });
        }
      });
      proc.on("error", (err) => {
        clearTimeout(timer);
        durationMs = Date.now() - started;
        resolve({ ok: false, status: "FAILED", output: "", sessionId: null, filesChanged: [], testsPassed: false, error: err.message, unavailable: false, durationMs });
      });
    });
  }
}

function extractSessionId(output: string): string | null {
  const match = /"sessionID?"\s*:\s*"([^"]+)"/i.exec(output);
  return match?.[1] ?? null;
}

function extractFilesChanged(output: string): string[] {
  const matches = [...output.matchAll(/(?:Modified|Created|Edited|Updated):\s*(.+)/gi)];
  return [...new Set(matches.map((m) => (m[1] ?? "").trim().replace(/,$/, "")))].filter(Boolean).slice(0, 20);
}

function parseLastTextEvent(output: string): string | null {
  const lines = output.split("\n").filter((l) => l.trim().length > 0);
  return lines.length ? lines[lines.length - 1]! : null;
}

const SECRET_PATTERNS: RegExp[] = [/gsk_[A-Za-z0-9]{10,}/g, /sk-or-v1-[A-Za-z0-9]+/g, /hf_[A-Za-z0-9]+/g, /sk_[A-Za-z0-9]{10,}/g];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "***");
  return out;
}