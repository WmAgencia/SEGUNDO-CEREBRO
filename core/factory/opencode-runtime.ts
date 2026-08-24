import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { redactSecrets } from "../exec/redact.ts";
import type { BrainConfig } from "../config/loader.ts";

export interface WorkspaceConfig {
  projectId: string;
  workspacePath: string;
  allowedCommands: string[];
  blockedPaths: string[];
}

export interface OpenCodeSession {
  sessionId: string;
  workspacePath: string;
  status: "REQUESTED" | "PLANNING" | "IMPLEMENTING" | "TESTING" | "COMPLETED" | "FAILED" | "ABORTED";
  startedAt: string;
  endedAt: string | null;
  output: string;
  filesChanged: string[];
  testsPassed: boolean | null;
  error: string | null;
}

export class OpenCodeRuntime {
  private activeProcesses = new Map<string, ReturnType<typeof spawn>>();

  validateWorkspace(workspacePath: string): boolean {
    if (!workspacePath || !existsSync(workspacePath)) return false;
    const resolved = path.resolve(workspacePath);
    const blocked = ["/Windows", "/Program Files", "C:\\Windows", "C:\\Program Files"];
    return !blocked.some((b) => resolved.startsWith(b));
  }

  async execute(
    config: BrainConfig,
    task: string,
    options: {
      agent?: string;
      model?: string;
      timeoutMs?: number;
      workspacePath?: string;
    } = {},
  ): Promise<OpenCodeSession> {
    const workspacePath = path.resolve(options.workspacePath ?? config.vaultPath);
    if (!this.validateWorkspace(workspacePath)) {
      throw new Error(`workspace inválido: ${workspacePath}`);
    }

    const sessionId = `oc.${Date.now().toString(36)}`;
    const model = options.model ?? "opencode/nemotron-3-ultra-free";
    const agent = options.agent ?? "build";

    return new Promise<OpenCodeSession>((resolve) => {
      const args = [
        "--experimental-strip-types",
        "-e",
        `process.env.SECOND_BRAIN_VAULT="${config.vaultPath}"`,
        "node_modules/.bin/opencode",
        "run",
        "--model", model,
        "--agent", agent,
        task,
      ];

      const proc = spawn("node", ["node_modules/.bin/opencode", "run", "--model", model, "--agent", agent, task], {
        cwd: workspacePath,
        env: { ...process.env },
        timeout: options.timeoutMs ?? 300000,
      });

      this.activeProcesses.set(sessionId, proc);
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

      proc.on("close", (code) => {
        this.activeProcesses.delete(sessionId);
        resolve({
          sessionId,
          workspacePath,
          status: code === 0 ? "COMPLETED" : "FAILED",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          output: redactSecrets(stdout.slice(0, 5000)),
          filesChanged: this.extractFilesChanged(stdout),
          testsPassed: /passed|OK|success/i.test(stdout),
          error: code !== 0 ? redactSecrets(stderr.slice(0, 1000)) : null,
        });
      });

      proc.on("error", (err) => {
        this.activeProcesses.delete(sessionId);
        resolve({
          sessionId,
          workspacePath,
          status: "FAILED",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          output: "",
          filesChanged: [],
          testsPassed: false,
          error: err.message,
        });
      });
    });
  }

  abort(sessionId: string): void {
    const proc = this.activeProcesses.get(sessionId);
    if (proc) proc.kill("SIGTERM");
    this.activeProcesses.delete(sessionId);
  }

  private extractFilesChanged(output: string): string[] {
    const matches = [...output.matchAll(/(?:Modified|Created|Edited):\s*(.+)/gi)];
    return matches.map((m) => (m[1] ?? "").trim()).filter(Boolean).slice(0, 20);
  }
}
