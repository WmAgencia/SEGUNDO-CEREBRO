/**
 * Enforce ONE folder per project under <root>/projetos.
 * Keeps only the canonical slugs passed as args (default: "nutriva").
 * Extra folders are moved to trash (reversible in Drive UI).
 */
import { readFileSync } from "node:fs";
import { findOrCreateFolder, listChildren, trashItem } from "../core/tools/drive-tools.ts";

for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"(.*)"$/, "$1");
}

const keep = new Set((process.argv.slice(2).length ? process.argv.slice(2) : ["nutriva"]).map((s) => s.toLowerCase()));

const rootName = process.env.GOOGLE_DRIVE_ROOT_FOLDER ?? "Secom";
const rootId = await findOrCreateFolder(rootName);
const projetosId = await findOrCreateFolder("projetos", rootId);
const children = await listChildren(projetosId);

console.log(`pastas em ${rootName}/projetos:`);
for (const child of children) {
  const isFolder = child.mimeType === "application/vnd.google-apps.folder";
  const slug = child.name.toLowerCase();
  if (isFolder && keep.has(slug)) {
    console.log(`  manter  : ${child.name}`);
  } else {
    await trashItem(child.id);
    console.log(`  lixeira : ${child.name}${isFolder ? "" : " (arquivo)"}`);
  }
}
console.log("ok — canonical:", [...keep].join(", "));
