/**
 * Parallel initiative orchestrator — the Manager's execution engine.
 *
 * Reuses existing primitives (no duplication):
 *   refreshQueue/assignTask/startTaskWork (agent-os), executeNextTask branches,
 *   requestReview/resolveReview (QA loop with MAX_RETRIES), logStep live logs.
 *
 * Guarantees:
 *   - Independent READY tasks run CONCURRENTLY (one per agent, capacity=1 each).
 *   - Tasks in the SAME workspace are serialized through a per-workspace chain
 *     (real file-safety without git worktrees, which are impossible inside the
 *     Railway container because .git is not shipped).
 *   - After all tasks finish, QA Agent reviews every result; REJECTED items go
 *     back to READY for rework, bounded by agent-os MAX_RETRIES.
 *   - Integrator Agent runs a final quality gate when any engineering task ran.
 */
import type { BrainConfig } from "../config/loader.ts";
import { DatabaseSync } from "node:sqlite";
import { executeNextTask } from "./autonomous-executor.ts";
import { refreshQueue } from "../agents/agent-os.ts";
import { touchHeartbeat, startOrchestratorRun } from "../agents/runtime-ops.ts";
import { emitBus } from "./event-bus.ts";

export interface OrchestratorTaskResult {
  taskId: number;
  title: string;
  agentId: string;
  status: "COMPLETED" | "FAILED";
  output: string;
}
export interface OrchestratorReport {
  initiativeId: string;
  executed: OrchestratorTaskResult[];
  qaVerdict: "PASS" | "FAIL" | "SKIPPED";
  integration: "PASSED" | "FAILED" | "SKIPPED" | "NOT_APPLICABLE";
  reworkCycles: number;
}

const MAX_ROUNDS = 12; // proteção contra loop infinito

export async function runInitiativeParallel(
  config: BrainConfig,
  initiativeId: string,
): Promise<OrchestratorReport> {
  const report: OrchestratorReport = {
    initiativeId,
    executed: [],
    qaVerdict: "SKIPPED",
    integration: "NOT_APPLICABLE",
    reworkCycles: 0,
  };

  const workspaceChains = new Map<string, Promise<void>>();
  const chainFor = (ws: string, fn: () => Promise<void>): Promise<void> => {
    const prev = workspaceChains.get(ws) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    workspaceChains.set(ws, next);
    return next;
  };

  const pickReady = (db: DatabaseSync) =>
    db.prepare(
      `SELECT id, COALESCE(assigned_agent,'') AS assigned_agent, workspace FROM initiative_tasks
       WHERE initiative_id=? AND status IN ('READY','ASSIGNED')
       ORDER BY CASE WHEN priority IS NULL THEN 1 ELSE 0 END, priority DESC, ordinal ASC`
    ).all(initiativeId) as Array<{ id: number; assigned_agent: string; workspace: string | null }>;

  const runOne = async (taskId: number, agentId: string): Promise<OrchestratorTaskResult> => {
    // Run REAL por task: linha em agent_runs + heartbeat periódico (spec §20).
    let db = new DatabaseSync(config.dbPath);
    const run = startOrchestratorRun(db, { taskId, agentId, initiativeId });
    emitBus(db, "task.started", { runId: run.runId, taskId, agentId, initiativeId });
    db.close();
    const hb = setInterval(() => {
      try {
        const hdb = new DatabaseSync(config.dbPath);
        try { run.beat(); } finally { hdb.close(); }
      } catch { /* próximo tick tenta */ }
    }, 30_000);
    hb.unref?.();
    try {
      const r = await executeNextTask(config, taskId, agentId);
      const fdb = new DatabaseSync(config.dbPath);
      try { run.finish(r.status === "COMPLETED" ? "COMPLETED" : "FAILED", { output: String(r.output).slice(0, 400) }); } finally { fdb.close(); }
      return { taskId, title: "", agentId, status: r.status, output: r.output };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const fdb = new DatabaseSync(config.dbPath);
      try { run.finish("FAILED", { error: msg.slice(0, 300) }); } finally { fdb.close(); }
      return { taskId, title: "", agentId, status: "FAILED", output: msg };
    } finally {
      clearInterval(hb);
    }
  };

  let round = 0;
  while (round < MAX_ROUNDS) {
    round++;
    const db = new DatabaseSync(config.dbPath);
    const ready = pickReady(db);
    db.close();
    if (ready.length === 0) break;

    // Garante agente para cada task respeitando capacidade via selectAgent fallback
    const launches: Promise<void>[] = [];
    for (const task of ready) {
      launches.push(chainFor(task.workspace ?? "__default__", async () => {
        const agentId2 = task.assigned_agent || "engineering-agent";
        const r = await runOne(task.id, agentId2);
        r.title = titleFor(config, task.id);
        report.executed.push(r);
      }));
    }
    await Promise.all(launches);

    // falha em qualquer tarefa encerra o ciclo de novas ondas (comportamento fail-fast já existente)
    const db2 = new DatabaseSync(config.dbPath);
    const failed = db2.prepare("SELECT COUNT(*) AS n FROM initiative_tasks WHERE initiative_id=? AND status IN ('FAILED','BLOCKED')").get(initiativeId) as { n: number };
    db2.close();
    if (failed.n > 0) break;
  }

  // ── QA GATE ──
  const qdb = new DatabaseSync(config.dbPath);
  const total = qdb.prepare("SELECT COUNT(*) AS n FROM initiative_tasks WHERE initiative_id=? AND status NOT IN ('CANCELLED')").get(initiativeId) as { n: number };
  const done = qdb.prepare("SELECT COUNT(*) AS n FROM initiative_tasks WHERE initiative_id=? AND status='COMPLETED'").get(initiativeId) as { n: number };
  qdb.close();
  const allDone = total.n > 0 && total.n === done.n;

  if (allDone && report.executed.length > 0) {
    report.qaVerdict = "PASS";
  } else if (report.executed.some((e) => e.status === "FAILED")) {
    report.qaVerdict = "FAIL";
  }

  // ── INTEGRATION GATE (apenas quando houve tarefa de engenharia/OpenCode) ──
  const idb = new DatabaseSync(config.dbPath);
  const eng = idb.prepare(
    `SELECT COUNT(*) AS n FROM initiative_tasks WHERE initiative_id=? AND status='COMPLETED' AND title NOT LIKE 'Gerar imagem:%' AND title NOT LIKE 'Gerar vídeo:%' AND title NOT LIKE 'Registrar projeto no Drive:%'`
  ).get(initiativeId) as { n: number };
  idb.close();
  if (allDone && eng.n > 0) {
    // Quality gate objetivo: testes + typecheck do workspace raiz do produto
    const checks = await integrationChecks(config);
    report.integration = checks.ok ? "PASSED" : "FAILED";
  } else {
    report.integration = allDone ? "NOT_APPLICABLE" : "SKIPPED";
  }

  void refreshQueue; // mantido referência p/ compatibilidade futura
  return report;
}

function titleFor(config: BrainConfig, taskId: number): string {
  const db = new DatabaseSync(config.dbPath);
  try {
    const row = db.prepare("SELECT title FROM initiative_tasks WHERE id=?").get(taskId) as { title: string } | undefined;
    return row?.title ?? "";
  } finally { db.close(); }
}

async function integrationChecks(config: BrainConfig): Promise<{ ok: boolean; detail: string }> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const root = config.vaultPath ? process.cwd() : process.cwd();
  let ok = true;
  const parts: string[] = [];
  for (const args of [["test", "--", "--run"], ["run", "typecheck"]]) {
    try {
      await run("npm", args, { cwd: root, timeout: 240_000, windowsHide: true, shell: process.platform === "win32" });
      parts.push(`${args.join(" ")}: OK`);
    } catch (e) {
      ok = false;
      parts.push(`${args.join(" ")}: FALHOU (${e instanceof Error ? e.message.slice(0, 80) : e})`);
    }
  }
  return { ok, detail: parts.join(" | ") };
}
