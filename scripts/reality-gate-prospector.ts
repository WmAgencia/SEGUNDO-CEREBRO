import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDatabase, applySchema } from "./storage/connection.ts";
import { runProspectorSearch, leadStats, listLeads, scoreCandidate } from "./core/comms/prospector-engine.ts";
import { getAgentOperationalState } from "./core/hq/agent-state.ts";

const dir = mkdtempSync(path.join(tmpdir(), "prospect-real-"));
const dbPath = path.join(dir, "b.db");
const db = openDatabase(dbPath);
applySchema(db);

// cria agente comercial p/ handoff
const AGENTS = ["sales-agent-01","sales-agent-02","sales-agent-03","sales-agent-04"];
for (const a of AGENTS) db.prepare("INSERT OR IGNORE INTO agents (id,name,status) VALUES (?,?, 'AVAILABLE')").run(a, a);

console.log("=== REALITY GATE PROSPECTOR (fonte Overpass, rede real) ===");
const t0 = Date.now();
const r = await runProspectorSearch(db, "barbearias em Sorocaba", { maxLeads: 40, goalName: "Encontrar barbearias em Sorocaba" });
const ms = Date.now() - t0;

console.log(`tempo: ${(ms/1000).toFixed(1)}s`);
console.log(`fontes usadas: ${r.sourcesUsed.join(", ")}`);
console.log(`leads encontrados: ${r.leadsFound} | salvos: ${r.leadsSaved} | duplicados: ${r.duplicates}`);
console.log(`qualificados (>=40pt): ${r.qualifiedForApproach.length}`);
console.log(`fontes bloqueadas: ${JSON.stringify(r.blockedSources)}`);
console.log(`ledger: ${JSON.stringify(r.ledger)}`);
console.log(`initiative criada: ${r.persistedGoal}`);

const stats = leadStats(db);
console.log(`leadStats: ${JSON.stringify(stats)}`);

console.log("\n=== AMOSTRA DE LEADS REAIS (dados persistidos) ===");
const leads = listLeads(db, { limit: 8 });
for (const l of leads) {
  console.log(`  ${l.companyName} | ${l.category ?? "?"} | ${l.city ?? "?"} | score=${l.qualificationScore} | status=${l.status} | src=${l.source}`);
  console.log(`     evidência: ${l.evidence.slice(0,2).join(" | ").slice(0,90)}`);
}

console.log("\n=== AMOSTRA SCORING EXPLICADO (determinístico) ===");
const scored = scoreCandidate({ company:"Exemplo", contact:null, website:null, source:"x", niche:"barber", location:"Sorocaba", signals:["no_website"], score:0, evidence:["phone_public","instagram_ativo"] });
console.log(`  score=${scored.score} presence=${scored.digitalPresence} motivo=${scored.scoreExplanation}`);

console.log("\n=== handoff para comercial via updateLeadStatus ===");
if (r.qualifiedForApproach.length > 0) {
  const id = r.qualifiedForApproach[0];
  const upd = (await import("./core/comms/leads.ts")).updateLeadStatus(db, id, "APPROACH_QUEUED", "sales-agent-01");
  console.log(`  lead ${id} -> ${upd?.status} agente=${upd?.assignedAgent}`);
}

// estado do agente comercial reflete que existe fila
console.log("\n=== estado operacional dos agentes ===");
for (const a of AGENTS) console.log(`  ${a}: ${getAgentOperationalState(db, a).state}`);

db.close();
rmSync(dir, { recursive: true, force: true });
console.log("\n=== FIM ===");
