import { readdirSync } from "node:fs";
import path from "node:path";
import { isIgnoredPath } from "../../core/permissions/ignore.ts";
import type { IgnoreRule } from "../../core/permissions/ignore.ts";

export interface ScannedFile {
  relPath: string;
  absPath: string;
}

const MARKDOWN_EXTS = new Set([".md", ".markdown"]);

function walk(
  vaultPath: string,
  currentRel: string,
  rules: IgnoreRule[],
  out: ScannedFile[],
): void {
  const absDir = path.join(vaultPath, currentRel);
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = currentRel === "" ? entry.name : `${currentRel}/${entry.name}`;
    if (entry.isDirectory()) {
      if (isIgnoredPath(rel, true, rules)) continue;
      walk(vaultPath, rel, rules, out);
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (!MARKDOWN_EXTS.has(ext)) continue;
      if (isIgnoredPath(rel, false, rules)) continue;
      out.push({ relPath: rel, absPath: path.join(vaultPath, rel.split("/").join(path.sep)) });
    }
  }
}

export function scanVault(vaultPath: string, rules: IgnoreRule[]): ScannedFile[] {
  const files: ScannedFile[] = [];
  walk(vaultPath, "", rules, files);
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return files;
}
