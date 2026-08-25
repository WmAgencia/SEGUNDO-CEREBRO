import { readFileSync } from "node:fs";
import { generateVideoAndArchive } from "../core/tools/video-tools.ts";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

console.log("gerando video de 5s...");
const r = await generateVideoAndArchive("green leaf growing timelapse, minimalist white background, nutrition concept");
console.log("status:", r.status, "| model:", r.model);
if (r.archived) console.log("drive:", r.archived.status, r.archived.webViewLink ?? r.archived.error);
else console.log("erro:", r.error);
