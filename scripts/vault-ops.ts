import { backupVault } from "../core/obsidian/vault-preservation.ts";
import { buildKnowledgeLayer } from "../core/obsidian/knowledge-layer.ts";
import type { BrainConfig } from "../core/config/loader.ts";
import { loadConfig } from "../core/config/loader.ts";

const config = loadConfig();
const vault = process.env.SECOND_BRAIN_VAULT;

console.log("=== VAULT PRESERVATION ===");
const backup = backupVault(config);
console.log(`backup: ${backup.backupPath}`);
console.log(`files backed up: ${backup.filesBackedUp}`);

console.log("\n=== KNOWLEDGE LAYER ===");
const layer = buildKnowledgeLayer(config, vault);
console.log(`notes created: ${layer.notesCreated}`);
console.log(`notes updated: ${layer.notesUpdated}`);

console.log("\nVAULT PRESERVED + KNOWLEDGE LAYER SYNCED");
