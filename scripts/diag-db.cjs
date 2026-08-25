const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync("C:/temp-brain/brain.db");
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
console.log("agent_task_logs:", tables.includes("agent_task_logs"));
console.log("projects:", tables.includes("projects"));
const meta = db.prepare("SELECT value FROM index_metadata WHERE key='schema_version'").get();
console.log("schema_version:", meta?.value);
try {
  const r = db.prepare("SELECT COUNT(*) AS n FROM initiative_tasks WHERE status='RUNNING'").get();
  console.log("running:", r.n);
} catch (e) { console.log("ERR running:", e.message); }
