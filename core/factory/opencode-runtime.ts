import { spawn, exec } from "node:child_process";
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
     const model = options.model ?? "opencode/nemotron-3.5-lightning-free";
    const agent = options.agent ?? "build";

    return new Promise<OpenCodeSession>((resolve) => {
       const command = resolveOpenCodeCommand();
       const commandArgs = ["run", "--model", model, "--agent", agent, task];

      const finish = (code: number | null, stdout: string, stderr: string) => {
        this.activeProcesses.delete(sessionId);
        resolve({
          sessionId,
          workspacePath,
          status: code === 0 ? "COMPLETED" : "FAILED",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
           output: redactSecrets(`${stdout}\n${stderr}`.slice(0, 5000)),
          filesChanged: this.extractFilesChanged(stdout),
          testsPassed: /passed|OK|success/i.test(stdout),
          error: code !== 0 ? redactSecrets(stderr.slice(0, 1000)) : null,
        });
      };

      if (process.platform === "win32") {
        const commandLine = `${command} ${commandArgs.map(quoteShellArg).join(" ")} < NUL`;
        const child = exec(commandLine, { cwd: workspacePath, env: process.env, timeout: options.timeoutMs ?? 300000, windowsHide: true }, (error, stdout, stderr) => {
          finish(error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout ?? "", stderr ?? (error ? error.message : ""));
        });
        this.activeProcesses.set(sessionId, child);
        return;
      }

       const proc = spawn(command, commandArgs, {
         cwd: workspacePath,
         env: { ...process.env },
         shell: false,
         timeout: options.timeoutMs ?? 300000,
      });

      this.activeProcesses.set(sessionId, proc);
      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => { stdout += data.toString(); });
      proc.stderr?.on("data", (data: Buffer) => { stderr += data.toString(); });

      proc.on("close", (code) => { finish(code, stdout, stderr); });

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

function quoteShellArg(value: string): string { return `"${value.replace(/"/g, '\\"')}"`; }

export function resolveOpenCodeCommand(): string {
  const local = process.platform === "win32" ? "node_modules/.bin/opencode.cmd" : "node_modules/.bin/opencode";
  if (existsSync(local)) return local;
  return "opencode";
}
