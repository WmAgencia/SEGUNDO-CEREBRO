import { readFileSync } from "node:fs";
// Carrega .env.local como o server faz
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
  if (m?.[1] && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
process.env.SECOND_BRAIN_VAULT ??= "C:\\Users\\junin\\OneDrive\\Documentos\\Obsidian Vault";

const { managerChat } = await import("../core/hq/manager.ts");
const { loadConfig } = await import("../core/config/loader.ts");

const config = loadConfig();
const SESSION = "reality-gate-closure";

async function gate(label, text, check) {
  const r = await managerChat(config, text, SESSION);
  const ok = check(r);
  console.log(`\n=== GATE ${label}: ${ok ? "PASS" : "FAIL"} ===`);
  console.log(`mode=${r.mode} intent=${r.intent} type=${r.type} requiresConfirmation=${r.requiresConfirmation}`);
  console.log(`resposta: ${r.message.slice(0, 220).replace(/\n/g, " | ")}`);
  if (r.contextCards?.length) console.log(`contextCards: ${JSON.stringify(r.contextCards)}`);
  return ok;
}

let passed = 0;
const a = await gate("A — 'Oi' → conversa natural", "Oi", (r) =>
  r.type === "conversation" && r.intent === "CHAT" && r.message.length > 10,
);
if (a) passed++;

const b = await gate("B — prospecção → continuação contextual", "Quero conversar sobre prospecção.", (r) => {
  const t = r.message.toLowerCase();
  return /prospec/.test(t) || /lead/.test(t) || /comercial/.test(t);
});
if (b) passed++;

const c = await gate("C — ideia de clientes → estratégia sem executar", "Estou pensando em encontrar clientes para vender sites.", (r) => {
  // NÃO pode criar goal/initiative sozinho
  return !r.actions.some((x) => x.status === "executed");
});
if (c) passed++;

console.log(`\n>>> REALITY GATE CHAT: ${passed}/3 PASS (com LLM real: ${process.env.OPENROUTER_API_KEY ? "SIM" : "NÃO"})`);
