import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// Load .env.local
const envPath = path.resolve(process.cwd(), ".env.local");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (match?.[1] && match[2] !== undefined && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

import { webSearch, webFetch, searchGoogleMaps, searchLinkedIn, searchDirectories } from "../core/tools/web-tools.ts";
import { generateImage } from "../core/tools/image-tools.ts";

async function test() {
  console.log("=== TEST 1: webSearch ===");
  try {
    const results = await webSearch("psicólogo Santa Catarina consultório", 3);
    console.log(`✅ webSearch: ${results.length} resultados`);
    results.forEach(r => console.log(`  • ${r.title} → ${r.url}`));
  } catch (e) { console.log(`❌ webSearch: ${e instanceof Error ? e.message : e}`); }

  console.log("\n=== TEST 2: webFetch ===");
  try {
    const result = await webFetch("https://pt.wikipedia.org/wiki/Nutri%C3%A7%C3%A3o");
    console.log(`✅ webFetch: status=${result.status} title="${result.title.slice(0,50)}" text=${result.text.length} chars`);
  } catch (e) { console.log(`❌ webFetch: ${e instanceof Error ? e.message : e}`); }

  console.log("\n=== TEST 3: searchGoogleMaps ===");
  try {
    const results = await searchGoogleMaps("psicólogo", "Florianópolis SC");
    console.log(`✅ searchGoogleMaps: ${results.length} resultados`);
    results.forEach(r => console.log(`  • ${r.title}`));
  } catch (e) { console.log(`❌ searchGoogleMaps: ${e instanceof Error ? e.message : e}`); }

  console.log("\n=== TEST 4: searchLinkedIn ===");
  try {
    const results = await searchLinkedIn("psicólogo", "Florianópolis");
    console.log(`✅ searchLinkedIn: ${results.length} resultados`);
    results.forEach(r => console.log(`  • ${r.title} → ${r.url.slice(0,60)}`));
  } catch (e) { console.log(`❌ searchLinkedIn: ${e instanceof Error ? e.message : e}`); }

  console.log("\n=== TEST 5: searchDirectories ===");
  try {
    const results = await searchDirectories("psicólogo", "Joinville SC");
    console.log(`✅ searchDirectories: ${results.length} resultados`);
  } catch (e) { console.log(`❌ searchDirectories: ${e instanceof Error ? e.message : e}`); }

  console.log("\n=== TEST 6: generateImage ===");
  try {
    const result = await generateImage("A cute golden retriever puppy in a garden, digital art");
    console.log(`✅ generateImage: status=${result.status} urls=${result.urls.length} model=${result.model}`);
    if (result.error) console.log(`  error: ${result.error}`);
  } catch (e) { console.log(`❌ generateImage: ${e instanceof Error ? e.message : e}`); }
}

test().catch(console.error);
