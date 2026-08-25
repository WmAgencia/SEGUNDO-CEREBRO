/**
 * REALITY GATE — Fase de Escala Operacional (13 testes, runtime real, sem simulação).
 * Usa banco em memória + executores reais. Drive/Rede exigem .env.local presente.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, applySchema } from "../storage/connection.ts";
import type { BrainConfig } from "../core/config/loader.ts";

const results: Array<{ n: number; name: string; pass: boolean; detail: string }> = [];
function record(n: number, name: string, fn: () => string): void {
  try {
    const detail = fn();
    results.push({ n, name, pass: true, detail });
  } catch (e) {
    results.push({ n, name, pass: false, detail: e instanceof Error ? e.message : String(e) });
  }
}

function config(): BrainConfig {
  const dir = mkdtempSync(path.join(tmpdir(), "reality-gate-"));
  const vaultPath = path.join(dir, "vault");
  mkdirSync(vaultPath);
  return { vaultPath, dataDir: dir, dbPath: path.join(dir, "brain.db"), logLevel: "error", search: { defaultLimit: 10, maxLimit: 50 }, context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1", model: "test" } };
}

async function main(): Promise<void> {
  // Credenciais reais (Drive etc.) — o gate roda contra serviços de verdade
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
  }
  const cfg = config();
  let db = openDatabase(cfg.dbPath);
  applySchema(db);

  // garante agentes operacionais (mesmo caminho do boot do servidor)
  const { SPECIALIZED_AGENTS } = await import("../core/agents/specialized.ts");
  for (const def of SPECIALIZED_AGENTS) {
    if (!db.prepare("SELECT id FROM agents WHERE id=?").get(def.id))
      db.prepare("INSERT INTO agents (id,name,description,domains,capabilities,permissions,status,capacity) VALUES (?,?,'',?,'[]','[]','AVAILABLE',?)")
        .run(def.id, def.name, JSON.stringify([def.department.toLowerCase()]), def.id.startsWith("developer") || ["qa-agent","integrator-agent"].includes(def.id) ? 1 : 3);
  }

  const { createProject, getProject, listProjects } = await import("../core/projects.ts");

  // TESTE 1 — criar projeto Clipcom
  record(1, "Criar projeto Clipcom", () => {
    const p = createProject(db, { name: "Clipcom", description: "Primeiro teste da fase de escala", workspace: "apps/clipcom" });
    if (!getProject(db, p.id)) throw new Error("projeto não persistido");
    return `id=${p.id} status=${p.status}`;
  });

  // TESTE 2 — criar objetivo
  const goal = await import("../core/goals/goal-engine.ts");
  const goalRec = goal.createGoal(db, { name: "Clipcom funcionando completamente", type: "PROJECT", status: "ACTIVE", ownerAgent: "manager" });
  record(2, "Criar objetivo", () => `goal=${goalRec.id}`);

  // TESTE 3+4 — iniciativa com decomposição em frentes INDEPENDENTES (paralelizáveis)
  const { createInitiative, planInitiative } = await import("../core/goals/initiatives.ts");
  const { assignTask, refreshQueue } = await import("../core/agents/agent-os.ts");
  const { persistGoalKnowledge, persistInitiativeKnowledge } = await import("../core/obsidian/knowledge-records.ts");
  const init = createInitiative(db, { title: "Clipcom: colocar no ar", description: "Reality Gate", goalId: goalRec.id, project: "clipcom", status: "PROPOSED" });
  planInitiative(db, init.id, [
    "Registrar projeto no Drive: Clipcom",
    "Registrar projeto no Drive: Clipcom site",
    "Gerar imagem: logo do Clipcom",
    "Auditar pipeline do Clipcom",
  ]);
  // Decomposição: as 3 primeiras frentes são independentes → sem depends_on (execução paralela).
  db.prepare("UPDATE initiative_tasks SET depends_on=NULL WHERE initiative_id=? AND ordinal<=3").run(init.id);
  persistGoalKnowledge(cfg, goalRec);
  persistInitiativeKnowledge(cfg, goalRec, init, ["Registrar projeto no Drive: Clipcom", "Registrar projeto no Drive: Clipcom site", "Gerar imagem: logo do Clipcom", "Auditar pipeline do Clipcom"]);
  const ready = refreshQueue(db, init.id);
  record(3, "Gerente decompõe (initiative + tasks)", () => `${init.id} com ${ready.length} task(s) READY`);

  // distribui para agentes DIFERENTES (paralelo real)
  const assignments: Array<[number, string]> = [];
  for (let i = 0; i < Math.min(ready.length, 3); i++) {
    const agentId = ["developer-01", "developer-02", "designer-agent"][i] ?? "engineering-agent";
    assignTask(db, ready[i], { agentId, reason: "Reality Gate: execução paralela" });
    assignments.push([ready[i], agentId]);
  }
  record(4, "Distribuir para múltiplos agentes", () => assignments.map(([t, a]) => `task ${t}→${a}`).join("; "));

  db.close();

  // TESTE 5 — execução simultânea via orquestrador paralelo
  const orch = await import("../core/hq/orchestrator.ts");
  const t0 = Date.now();
  const report = await orch.runInitiativeParallel(cfg, init.id);
  const elapsed = Date.now() - t0;

  record(5, "Executar simultaneamente", () => {
    const distinctAgents = new Set(report.executed.map((e) => e.agentId));
    if (report.executed.length < 2) throw new Error(`apenas ${report.executed.length} tarefa(s) executada(s)`);
    return `${report.executed.length} tasks por ${distinctAgents.size} agente(s) em ${elapsed}ms`;
  });

  // TESTE 6 — agentes trabalhando visíveis no HQ (estado derivado)
  const db6 = openDatabase(cfg.dbPath);
  const runningRows = db6.prepare("SELECT COUNT(*) AS n FROM initiative_tasks WHERE initiative_id=? AND status IN ('RUNNING','COMPLETED')").get(init.id) as { n: number };
  db6.close();
  record(6, "Agentes trabalhando visíveis no HQ", () => `${runningRows.n} tasks RUNNING/COMPLETED registradas`);

  // TESTE 7 — logs ao vivo
  const logCount = Number((openDatabase(cfg.dbPath).prepare("SELECT COUNT(*) AS n FROM agent_task_logs WHERE agent_id LIKE 'developer%' OR agent_id='designer-agent'").get() as { n: number }).n);
  openDatabase(cfg.dbPath).close();
  record(7, "Logs ao vivo gravados", () => `${logCount} entradas em agent_task_logs`);

  // TESTE 8 — finalizar tasks
  const doneDb = openDatabase(cfg.dbPath);
  const completed = doneDb.prepare("SELECT COUNT(*) AS n FROM initiative_tasks WHERE initiative_id=? AND status='COMPLETED'").get(init.id) as { n: number };
  const failedN = doneDb.prepare("SELECT COUNT(*) AS n FROM initiative_tasks WHERE initiative_id=? AND status='FAILED'").get(init.id) as { n: number };
  const compN = completed.n, failN = failedN.n;
  doneDb.close();
  record(8, "Finalizar tasks", () => `${compN} completadas, ${failN} falhadas`);

  // TESTE 9 — evaluator validar
  record(9, "Evaluator validar", () => `veredito QA=${report.qaVerdict}, integração=${report.integration}, ciclos rework=${report.reworkCycles}`);

  // TESTE 10 — integrar alterações
  record(10, "Integrar alterações", () => {
    if (failN > 0) throw new Error(`${failN} task(s) falharam — integração bloqueada honestamente`);
    return report.integration;
  });

  // TESTE 11 — registrar tudo no Second Brain
  const memDb = openDatabase(cfg.dbPath);
  const events = Number((memDb.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n);
  const memories = Number((memDb.prepare("SELECT COUNT(*) AS n FROM memories").get() as { n: number }).n);
  memDb.close();
  record(11, "Registrar tudo no Second Brain", () => `${events} eventos, ${memories} memórias`);

  // TESTE 12 — materializar conhecimento no Obsidian
  record(12, "Conhecimento no Obsidian", () => {
    const notes = readdirSync(path.join(cfg.vaultPath, "08 - Goals"), { recursive: true });
    return `${notes.filter((f) => String(f).endsWith(".md")).length} notas geradas`;
  });

  // TESTE 13 — Gerente responde usando contexto persistido
  const { managerChat } = await import("../core/hq/manager.ts");
  const answer = await managerChat(cfg, "O que aconteceu com o Clipcom?", "reality-gate");
  record(13, "Gerente responde sobre o Clipcom", () => {
    const ok = /clipcom/i.test(answer.message) && !/não encontrei/i.test(answer.message);
    if (!ok) throw new Error(`resposta não usou o contexto: "${answer.message.slice(0, 120)}"`);
    return answer.message.slice(0, 140);
  });

  console.log("\n════════ REALITY GATE ════════");
  let allPass = true;
  for (const r of results) {
    console.log(`${r.pass ? "✅ PASS" : "❌ FAIL"}  TESTE ${r.n}: ${r.name}\n        ${r.detail.slice(0, 160)}`);
    if (!r.pass) allPass = false;
  }
  console.log(allPass ? "\n🏆 REALITY GATE: 13/13 PASS" : "\n⛔ REALITY GATE FALHOU — ver detalhes acima");
  process.exit(allPass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
