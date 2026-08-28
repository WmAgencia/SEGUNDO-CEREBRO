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
import { existsSync } from "node:fs";
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
  // Prefer a project-local binary when present; otherwise resolve `opencode`
  // from PATH (global install). On Windows the global shim is a .ps1/.cmd
  // resolved by the shell, so we return the bare name and spawn with shell.
  if (process.platform === "win32") {
    for (const c of ["node_modules/.bin/opencode.cmd", "node_modules/.bin/opencode.exe", "node_modules/.bin/opencode"]) {
      if (existsSync(c)) return c;
    }
    return "opencode";
  }
  return "opencode";
}

/** Resolve o modelo do runtime Graph/OpenCode: SECOND_BRAIN_GRAPH_MODEL >
 *  modelo já configurado do SECOND_BRAIN_GRAPH_PROVIDER. Nunca inventa id —
 *  usa o valor configurado do provider; se ausente, retorna null (OpenCode usa
 *  o default dele). */
export function resolveGraphModel(): string | null {
  if (process.env.SECOND_BRAIN_GRAPH_MODEL) return process.env.SECOND_BRAIN_GRAPH_MODEL;
  const provider = (process.env.SECOND_BRAIN_GRAPH_PROVIDER ?? "").toLowerCase();
  if (provider === "groq") return process.env.GROQ_MODEL ?? null;
  if (provider === "alibaba" || provider === "qwen" || provider === "dashscope") return process.env.ALIBABA_MODEL ?? null;
  if (provider === "openrouter") return process.env.OPENROUTER_MODEL ?? null;
  return null;
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

    // Modelo configurável (FASE Groq+Alibaba, seção 10): node model explícito >
    // SECOND_BRAIN_GRAPH_MODEL > modelo do SECOND_BRAIN_GRAPH_PROVIDER. Nunca
    // inventa model id: usa o valor já configurado do provider escolhido.
    const model = opts.model ?? resolveGraphModel();
    const args = ["run", "--format", "json", "--agent", opts.agentId];
    if (model) args.push("--model", model);
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
        const parsed = parseOpenCodeOutput(stdout);
        // HONEST result: only COMPLETED when there is real assistant text.
        // OpenCode can exit 0 while emitting an error event (e.g. model
        // capacity/rate limit) — that must surface as FAILED with evidence,
        // never as a fake success.
        if (parsed.text.trim().length > 0 && !parsed.fatalError) {
          resolve({
            ok: true,
            status: "COMPLETED",
            output: redact(parsed.text.slice(0, 8000)),
            sessionId: parsed.sessionId,
            filesChanged: parsed.filesChanged.length ? parsed.filesChanged : extractFilesChanged(stdout),
            testsPassed: parsed.testsPassed ?? /passed|\bOK\b|success/i.test(`${stdout}\n${stderr}`),
            error: null,
            unavailable: false,
            durationMs,
          });
        } else {
          const errMsg = parsed.fatalError ?? (stderr.trim() ? redact(stderr.slice(0, 1000)) : `exit code ${code}${code === 0 ? " (sem resposta do modelo)" : ""}`);
          resolve({
            ok: false,
            status: "FAILED",
            output: redact((parsed.text || stdout).slice(0, 4000)),
            sessionId: parsed.sessionId,
            filesChanged: parsed.filesChanged,
            testsPassed: false,
            error: redact(errMsg.slice(0, 1000)),
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

/**
 * Parses OpenCode `--format json` stdout: a stream of JSON-line events.
 * Extracts the session id, the last assistant text, any file edits, the test
 * signal, and a fatal LLM error (e.g. ContextOverflow / rate limit). Returns
 * empty text + fatalError when the run produced no usable answer, so the graph
 * marks the node FAILED (never a fake success).
 */
export function parseOpenCodeOutput(stdout: string): {
  sessionId: string | null;
  text: string;
  filesChanged: string[];
  testsPassed: boolean | null;
  fatalError: string | null;
} {
  let sessionId: string | null = null;
  let text = "";
  const filesChanged: string[] = [];
  let testsPassed: boolean | null = null;
  let fatalError: string | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let evt: Record<string, unknown>;
    try { evt = JSON.parse(trimmed) as Record<string, unknown>; } catch { continue; }

    if (typeof evt.sessionID === "string") sessionId = evt.sessionID;

    const type = String(evt.type ?? "");
    if (type === "error") {
      const err = evt.error as { name?: string; data?: { message?: string } } | undefined;
      fatalError = err?.data?.message ?? err?.name ?? "erro desconhecido do OpenCode";
    }

    // Assistant text can arrive in message/text events depending on version.
    const msg = evt.message as { content?: Array<{ type?: string; text?: string }> } | undefined;
    if (msg?.content) {
      for (const part of msg.content) {
        if (part?.type === "text" && typeof part.text === "string") text = part.text;
      }
    }
    if (typeof evt.text === "string" && (evt.text as string).trim()) text = evt.text as string;

    // Tool/file evidence
    const tool = evt.tool as string | undefined;
    if (tool === "write" || tool === "edit" || tool === "apply_patch") {
      const fp = (evt.file ?? evt.path ?? evt.filePath) as string | undefined;
      if (fp) filesChanged.push(fp);
    }
    if (/test|vitest|pytest/i.test(trimmed) && /\bpassed\b/i.test(trimmed)) testsPassed = true;
  }

  return { sessionId, text, filesChanged: [...new Set(filesChanged)].slice(0, 40), testsPassed, fatalError };
}

function extractFilesChanged(output: string): string[] {
  const matches = [...output.matchAll(/(?:Modified|Created|Edited|Updated):\s*(.+)/gi)];
  return [...new Set(matches.map((m) => (m[1] ?? "").trim().replace(/,$/, "")))].filter(Boolean).slice(0, 20);
}

const SECRET_PATTERNS: RegExp[] = [/gsk_[A-Za-z0-9]{10,}/g, /sk-or-v1-[A-Za-z0-9]+/g, /hf_[A-Za-z0-9]+/g, /sk_[A-Za-z0-9]{10,}/g];

export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, "***");
  return out;
}