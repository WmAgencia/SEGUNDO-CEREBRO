import { buildKnowledgeLayer } from "../core/obsidian/knowledge-layer.ts";
import { loadConfig } from "../core/config/loader.ts";

const config = loadConfig();
const vault = process.env.SECOND_BRAIN_VAULT;
console.log("=== KNOWLEDGE LAYER ===");
const result = buildKnowledgeLayer(config, vault);
console.log(`folders: ${result.foldersCreated.length}`);
console.log(`created: ${result.notesCreated}`);
console.log(`updated: ${result.notesUpdated}`);
