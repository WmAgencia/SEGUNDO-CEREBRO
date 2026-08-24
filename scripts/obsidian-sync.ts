import { syncToObsidian } from "../core/obsidian/obsidian-sync.ts";
import { loadConfig } from "../core/config/loader.ts";

const config = loadConfig();
const vaultPath = process.env.SECOND_BRAIN_VAULT;
console.log("=== OBSIDIAN SYNC ===");
const result = syncToObsidian(config, vaultPath);
console.log(`folders created: ${result.foldersCreated.length}`);
console.log(`notes created: ${result.notesCreated}`);
console.log(`notes updated: ${result.notesUpdated}`);
console.log(`skipped: ${result.skipped}`);
if (result.foldersCreated.length > 0) {
  console.log("new folders:", result.foldersCreated.join(", "));
}
