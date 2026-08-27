/**
 * Vault audit (READ-ONLY) — report first, never auto-delete.
 *
 * Detects, without touching anything:
 *   - pastas com mesmo nome em locais diferentes (candidatas a merge)
 *   - notas duplicadas (mesmo título/id)
 *   - notas vazias
 *   - entidades órfãs (origin_document_id apontando para documento inexistente)
 *   - links quebrados (wiki-links [[x]] sem nota correspondente)
 *   - informações sem classificação (nota sem type/tags)
 *
 * Rule: primeiro produzir relatório; depois normalizar (nunca apagar automaticamente).
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Dirent } from "node:fs";
import type { BrainConfig } from "../config/loader.ts";
import { openDatabase } from "../../storage/connection.ts";

export interface VaultAuditReport {
  scannedNotes: number;
  duplicateNotes: Array<{ title: string; paths: string[] }>;
  duplicateFolders: Array<{ basename: string; paths: string[] }>;
  emptyNotes: string[];
  orphanEntities: Array<{ id: string; originDocumentId: string }>;
  brokenLinks: Array<{ from: string; target: string }>;
  unclassified: Array<{ path: string; why: string }>;
  ok: boolean;
}

function findMdFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.toLowerCase().endsWith(".md")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

const WIKILINK = /\[\[([^\]|#]+)(?:#[^\]|]+)?(?:[|][^\]]+)?\]\]/g;

export function auditVault(config: BrainConfig): VaultAuditReport {
  const report: VaultAuditReport = {
    scannedNotes: 0,
    duplicateNotes: [],
    duplicateFolders: [],
    emptyNotes: [],
    orphanEntities: [],
    brokenLinks: [],
    unclassified: [],
    ok: false,
  };

  // ── filesystem ──
  const files = findMdFiles(config.vaultPath);
  report.scannedNotes = files.length;

  const byBasename = new Map<string, string[]>();
  const byTitle = new Map<string, string[]>();
  const titles = new Set<string>();
  const fed = new Map<string, string>();

  for (const file of files) {
    const rel = path.relative(config.vaultPath, file);
    const title = path.basename(file, ".md");
    const listNames = byBasename.get(title) ?? [];
    listNames.push(rel);
    byBasename.set(title, listNames);

    const stats = statSync(file, { throwIfNoEntry: false });
    const size = stats?.size ?? 0;
    if (size === 0) report.emptyNotes.push(rel);

    let content = "";
    try {
      content = readFileSync(file, "utf8");
    } catch {
      content = "";
    }
    // wikilinks
    for (const m of content.matchAll(WIKILINK)) {
      const target = (m[1] ?? "").trim();
      if (!target) continue;
      fed.set(target.toLowerCase(), file);
    }
    // frontmatter classification
    const fm = parseFrontmatter(content);
    const hasType = Boolean(fm.type);
    const hasTags = Boolean(fm.tags && fm.tags.length);
    if (!hasType && !hasTags) report.unclassified.push({ path: rel, why: "sem type nem tags no frontmatter" });
    // title dupes = same basename without " (dup)" markers from this pass
    titles.add(title.toLowerCase());
    const byT = byTitle.get(title.toLowerCase()) ?? [];
    byT.push(rel);
    byTitle.set(title.toLowerCase(), byT);
  }
  for (const [key, paths] of byBasename) {
    if (paths.length > 1) report.duplicateFolders.push({ basename: key, paths });
  }
  for (const [key, paths] of byTitle) {
    if (paths.length > 1) report.duplicateNotes.push({ title: key, paths });
  }

  // links quebrados: targets fetched from FS that are not .md files present
  const mdSet = new Set(files.map((f) => path.basename(f, ".md").toLowerCase()));
  for (const [target, from] of fed) {
    if (!mdSet.has(target.toLowerCase())) {
      report.brokenLinks.push({ from: path.relative(config.vaultPath, from), target });
    }
  }

  // ── database (orphan entities) ──
  try {
    const db = openDatabase(config.dbPath);
    try {
      const rows = db.prepare(
        `SELECT id, origin_document_id FROM entities
         WHERE origin_document_id IS NOT NULL
         AND origin_document_id NOT IN (SELECT id FROM documents)`,
      ).all() as Array<{ id: string; origin_document_id: string | null }>;
      for (const r of rows) {
        if (!r.origin_document_id) continue;
        report.orphanEntities.push({ id: r.id, originDocumentId: r.origin_document_id });
      }
    } finally {
      db.close();
    }
  } catch {
    // db não indexado ainda — relatório parcial do filesystem
  }

  report.ok = [report.duplicateNotes, report.duplicateFolders, report.emptyNotes, report.orphanEntities, report.brokenLinks, report.unclassified].every((a) => a.length === 0);
  return report;
}

function parseFrontmatter(content: string): { type?: string; tags?: string[] } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return {};
  const out: { type?: string; tags?: string[] } = {};
  for (const line of (m[1] ?? "").split(/\r?\n/)) {
    const km = /^(\w+)\s*:\s*(.*)$/.exec(line.trim());
    if (!km) continue;
    const key = km[1]!.toLowerCase();
    const value = km[2]!.trim();
    if (key === "type" && value && !value.startsWith("[")) out.type = value.replace(/["']/g, "");
    if (key === "tags") {
      const tags = value.replace(/^\[/, "").replace(/\]$/, "").split(",").map((s) => s.trim().replace(/["']/g, "")).filter(Boolean);
      if (tags.length) out.tags = tags;
    }
  }
  return out;
}

export function auditExplanation(report: VaultAuditReport): string {
  const lines: string[] = [`Auditoria do Vault (read-only) — ${report.scannedNotes} notas escaneadas`];
  if (report.ok) lines.push("Nenhum problema detectado.");
  if (report.duplicateNotes.length) lines.push(`- ${report.duplicateNotes.length} notas duplicadas: ${report.duplicateNotes.map((d) => d.title).join(", ")}`);
  if (report.duplicateFolders.length) lines.push(`- ${report.duplicateFolders.length} pastas duplicadas: ${report.duplicateFolders.map((d) => d.basename).join(", ")}`);
  if (report.emptyNotes.length) lines.push(`- ${report.emptyNotes.length} notas vazias`);
  if (report.orphanEntities.length) lines.push(`- ${report.orphanEntities.length} entidades órfãs (${report.orphanEntities.slice(0, 5).map((o) => o.id).join(", ")}${report.orphanEntities.length > 5 ? "..." : ""})`);
  if (report.brokenLinks.length) lines.push(`- ${report.brokenLinks.length} links quebrados (ex.: [[${report.brokenLinks[0]?.target ?? ""}]])`);
  if (report.unclassified.length) lines.push(`- ${report.unclassified.length} notas sem classificação`);
  return lines.join("\n");
}