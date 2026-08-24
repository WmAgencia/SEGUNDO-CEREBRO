import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import path from "node:path";
import type { BrainConfig } from "../config/loader.ts";

export interface VaultBackup {
  backupPath: string;
  filesBackedUp: number;
  timestamp: string;
}

export function backupVault(config: BrainConfig): VaultBackup {
  const vault = config.vaultPath;
  if (!existsSync(vault)) throw new Error(`vault not found: ${vault}`);

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupDir = path.join(config.dataDir, "vault-backups", timestamp);
  mkdirSync(backupDir, { recursive: true });

  let filesBackedUp = 0;

  function copyRecursive(src: string, dest: string): void {
    if (!existsSync(src)) return;
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) copyRecursive(srcPath, destPath);
      else {
        try {
          require("node:fs").copyFileSync(srcPath, destPath);
          filesBackedUp++;
        } catch {}
      }
    }
  }

  copyRecursive(vault, path.join(backupDir, "vault"));

  // Record backup metadata
  db_log(config.dbPath, "vault_backup", null, {
    backupPath: backupDir,
    filesBackedUp,
    vaultPath: vault,
  });

  return { backupPath: backupDir, filesBackedUp, timestamp };
}

export interface ConflictRecord {
  file: string;
  markdownContent: string;
  databaseContent: string;
  sourceMd: string;
  sourceDb: string;
}

export function detectConflicts(
  config: BrainConfig,
  mdFilePath: string,
  dbContent: string,
  dbSource: string,
): ConflictRecord | null {
  if (!existsSync(mdFilePath)) return null;
  const mdContent = readFileSync(mdFilePath, "utf8");

  const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const normMd = normalize(mdContent);
  const normDb = normalize(dbContent);

  // If MD already contains the DB content → no conflict
  if (normMd.includes(normDb.slice(0, Math.min(100, normDb.length)))) return null;

  // If they're completely different content about the same topic
  const mdWords = new Set(normMd.split(" "));
  const dbWords = new Set(normDb.split(" "));
  let overlap = 0;
  for (const w of dbWords) if (mdWords.has(w)) overlap++;
  const similarity = overlap / Math.max(1, dbWords.size);

  // If <50% overlap and both have meaningful content → CONFLICT
  if (similarity < 0.5 && mdContent.length > 50 && dbContent.length > 50) {
    return {
      file: mdFilePath,
      markdownContent: mdContent.slice(0, 200),
      databaseContent: dbContent.slice(0, 200),
      sourceMd: "obsidian",
      sourceDb: dbSource,
    };
  }

  return null;
}

export function recordConflict(
  config: BrainConfig,
  conflict: ConflictRecord,
): void {
  const conflictsDir = path.join(config.vaultPath, "07 - Decisions", "Conflicts");
  mkdirSync(conflictsDir, { recursive: true });
  const file = path.join(
    conflictsDir,
    `conflict-${Date.now().toString(36)}.md`,
  );
  const content = [
    "---",
    "type: conflict",
    'status: "PENDING_REVIEW"',
    "---",
    "",
    "# CONFLICT",
    "",
    `## File`,
    `${conflict.file}`,
    "",
    `## Obsidian Content`,
    `${conflict.markdownContent}`,
    "",
    `## Database Content`,
    `${conflict.databaseContent}`,
    "",
    `## Sources`,
    `- MD: ${conflict.sourceMd}`,
    `- DB: ${conflict.sourceDb}`,
    "",
    "NÃO resolver automaticamente.",
    "Revisar manualmente e escolher ou combinar.",
  ].join("\n");
  writeFileSync(file, content, "utf8");
}

function db_log(dbPath: string, eventType: string, subject: string | null, payload: Record<string, unknown>): void {
  try {
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO events (event_type, subject, payload) VALUES (?, ?, ?)")
      .run(eventType, subject, JSON.stringify(payload));
    db.close();
  } catch {}
}
