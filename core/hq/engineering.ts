import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import type { BrainConfig } from "../config/loader.ts";
import { OpenCodeRuntime } from "../factory/opencode-runtime.ts";
import { startTaskWork, submitResult } from "../agents/agent-os.ts";
import { ProfessionalAgentHarness, nutrivaSandbox } from "../agents/professional-harness.ts";
import { validateSandbox } from "../agents/professional-harness.ts";
import { createNotification } from "./notifications.ts";

const execFileAsync = promisify(execFile);
export interface EngineeringExecution { taskId: number; runId: string; sessionId: number; status: "COMPLETED" | "FAILED"; testsPassed: boolean; typecheckPassed: boolean; output: string; error: string | null; filesChanged: string[]; }

export async function executeEngineeringTask(config: BrainConfig, input: { taskId: number; agentId: string; workspacePath: string; task?: string }): Promise<EngineeringExecution> {
  const sandbox = nutrivaSandbox(input.workspacePath);
  if (!validateSandbox(sandbox, "src/server.ts").allowed) throw new Error("engineering workspace outside sandbox");
  const db = new DatabaseSync(config.dbPath);
  const harness = new ProfessionalAgentHarness(db);
  const row = db.prepare("SELECT initiative_id,title FROM initiative_tasks WHERE id=?").get(input.taskId) as { initiative_id: string; title: string } | undefined;
  if (!row) { db.close(); throw new Error(`task not found: ${input.taskId}`); }
  const run = harness.start({ task: input.task ?? row.title, agentId: input.agentId, projectId: "nutriva", taskId: input.taskId, initiativeId: row.initiative_id });
  harness.move(run.id, "READY"); harness.move(run.id, "PLANNING"); harness.move(run.id, "RUNNING"); harness.checkpoint(run.id, { taskId: input.taskId, workspace: input.workspacePath });
  const sessionId = startTaskWork(db, input.taskId, input.agentId);
  db.close();
  const runtime = new OpenCodeRuntime();
  const session = await runtime.execute(config, input.task ?? row.title, { workspacePath: input.workspacePath, agent: "build" });
  const root = path.resolve(input.workspacePath, "../..");
  const checks = await runChecks(root);
  const passed = session.status === "COMPLETED" && checks.testsPassed && checks.typecheckPassed;
  const resultDb = new DatabaseSync(config.dbPath);
  try {
    const currentHarness = new ProfessionalAgentHarness(resultDb);
    currentHarness.move(run.id, "EVALUATING");
    if (passed) {
      submitResult(resultDb, config, { taskId: input.taskId, agentId: input.agentId, sessionId, summary: "OpenCode + testes + typecheck avaliados", output: session.output, artifacts: session.filesChanged, sources: ["opencode", "npm test", "npm run typecheck"] });
      currentHarness.recordEval(run.id, "engineering_checks", "PASS", "OpenCode, testes e typecheck passaram", ["exit_code=0"]); currentHarness.move(run.id, "COMPLETED");
      createNotification(resultDb, { type:'task_completed', title:`✅ Tarefa concluída: ${input.taskId}`, body:session.output.slice(0,300), agentId:input.agentId, taskId:input.taskId });
    } else {
      resultDb.prepare("UPDATE initiative_tasks SET status='FAILED',result=?,evidence=?,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(session.error ?? "engineering checks failed", JSON.stringify({ opencode: session.status, testsPassed: checks.testsPassed, typecheckPassed: checks.typecheckPassed }), input.taskId);
      resultDb.prepare("INSERT INTO events (event_type,subject,payload) VALUES ('task_failed',?,?)").run(input.agentId, JSON.stringify({ taskId: input.taskId, reason: "independent evaluator failed" }));
      currentHarness.recordEval(run.id, "engineering_checks", "FAIL", "Independent checks failed", [session.status, String(checks.testsPassed), String(checks.typecheckPassed)]); currentHarness.move(run.id, "REWORKING");
      createNotification(resultDb, { type:'task_failed', title:`❌ Tarefa falhou: ${input.taskId}`, body:(session.error??'Erro').slice(0,300), agentId:input.agentId, taskId:input.taskId });
    }
    return { taskId: input.taskId, runId: run.id, sessionId, status: passed ? "COMPLETED" : "FAILED", testsPassed: checks.testsPassed, typecheckPassed: checks.typecheckPassed, output: session.output, error: session.error, filesChanged: session.filesChanged };
  } finally { resultDb.close(); }
}

async function runChecks(cwd: string): Promise<{ testsPassed: boolean; typecheckPassed: boolean }> {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = async (args: string[]): Promise<boolean> => { try { await execFileAsync(npm, args, { cwd, timeout: 180_000, windowsHide: true, shell: process.platform === "win32" }); return true; } catch { return false; } };
  return { testsPassed: await run(["test", "--", "--run"]), typecheckPassed: await run(["run", "typecheck"]) };
}
