import { loadConfig } from "../core/config/loader.ts";
import { openDatabase, applySchema } from "../storage/connection.ts";
import { runInitiativeAutonomously } from "../core/hq/autonomous-executor.ts";
import path from "node:path";

const config = loadConfig();
const db = openDatabase(config.dbPath);
applySchema(db);
db.close();

const initiativeId = "init.c9511fe72d";
const workspace = path.resolve(process.cwd(), "apps", "nutriva");
console.log(`Running initiative ${initiativeId} in workspace ${workspace}`);

try {
  const results = await runInitiativeAutonomously(config, initiativeId, workspace);
  console.log(`Done. ${results.length} tasks executed.`);
  for (const r of results) {
    console.log(`  task=${r.taskId} status=${r.status} next=${r.nextTaskId} goalComplete=${r.goalComplete}`);
    if (r.status === 'FAILED') console.log(`    error: ${r.output?.slice(0,200)}`);
  }
} catch (err) {
  console.error(`FAILED: ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.error(err.stack.split('\n').slice(0,5).join('\n'));
}
