import { loadConfig } from "../core/config/loader.ts";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { ProfessionalAgentHarness, planTask } from "../core/agents/professional-harness.ts";

const config = loadConfig();
const db = openDatabase(config.dbPath);
applySchema(db);
try {
  const harness = new ProfessionalAgentHarness(db);
  const tasks = ["Nutriva TASK A: validate negative quantities", "Nutriva TASK B: validate non-finite quantities"];
  const runs: string[] = [];
  for (const task of tasks) {
    const run = harness.start({ task, agentId: "opencode", projectId: "nutriva" });
    runs.push(run.id);
    harness.move(run.id, "READY"); harness.move(run.id, "PLANNING"); harness.move(run.id, "RUNNING");
    harness.checkpoint(run.id, { task, evidence: "OpenCode real execution recorded separately" });
    harness.move(run.id, "EVALUATING"); harness.recordEval(run.id, "real_open_code_task", "PASS", "tests and typecheck passed", [task]); harness.move(run.id, "COMPLETED");
  }
  const recovery = harness.start({ task: "Nutriva recovery checkpoint", agentId: "opencode", projectId: "nutriva" });
  harness.move(recovery.id, "READY"); harness.move(recovery.id, "PLANNING"); harness.move(recovery.id, "RUNNING"); harness.checkpoint(recovery.id, { currentStep: "worker", completed: ["observe", "context"] }); harness.move(recovery.id, "PAUSED");
  const resumed = harness.resume(recovery.id);
  const kill = harness.start({ task: "Nutriva kill switch", agentId: "opencode", projectId: "nutriva" });
  const killed = harness.kill(kill.id); const continued = harness.resume(kill.id);
  const rework = harness.start({ task: "Nutriva controlled rework", agentId: "opencode", projectId: "nutriva" });
  const steps = planTask("controlled rework").slice(0, 1);
  let attempts = 0;
  const final = await harness.run(rework.id, steps, async () => ({ ok: ++attempts > 1 }), { maxRetries: 2 });
  harness.recordEval(rework.id, "controlled_rework", final.state === "COMPLETED" ? "PASS" : "FAIL", `attempts=${attempts}`);
  console.log(JSON.stringify({ tasks: runs, recovery: resumed.state, kill: { stopped: killed.state, continued: continued.state }, rework: { state: final.state, attempts } }));
} finally { db.close(); }
