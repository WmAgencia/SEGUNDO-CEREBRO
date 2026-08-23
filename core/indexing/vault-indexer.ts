import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseMarkdown } from "../../connectors/obsidian/markdown.ts";
import type { ParsedNote } from "../../connectors/obsidian/markdown.ts";
import { scanVault } from "../../connectors/obsidian/scanner.ts";
import type { BrainConfig } from "../config/loader.ts";
import { createLogger } from "../logger/logger.ts";
import { loadIgnoreRules } from "../permissions/ignore.ts";
import type { IgnoreRule } from "../permissions/ignore.ts";
import { chunkBody } from "./chunker.ts";
import { applySchema } from "../../storage/connection.ts";

const log = createLogger("indexer");

export interface IndexReport {
  scanned: number;
  added: number;
  changed: number;
  removed: number;
  renamed: number;
  unchanged: number;
  unresolvedLinks: number;
  errors: Array<{ path: string; error: string }>;
  durationMs: number;
}

interface ExistingDoc {
  id: string;
  path: string;
  hash: string;
}

interface FileEntry {
  relPath: string;
  absPath: string;
  hash: string;
}

const OBSIDIAN_SOURCE_ID = "src.obsidian";

const FOLDER_TYPE: Record<string, string> = {
  "01 - Projects": "project",
  "02 - Areas": "area",
  "03 - Knowledge": "knowledge",
  "04 - Ideas": "idea",
  "05 - Decisions": "decision",
  "06 - Procedures": "procedure",
  "08 - Research": "research",
};

function inferFolderType(relPath: string): string | undefined {
  const firstSegment = relPath.split(/[/\\]/)[0];
  if (!firstSegment) return undefined;
  return FOLDER_TYPE[firstSegment];
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function posixify(p: string): string {
  return p.split("\\").join("/");
}

interface ProcessedNote {
  docId: string;
  entityId?: string;
  note: ParsedNote;
}

export function indexVault(config: BrainConfig): IndexReport {
  const startedAt = Date.now();
  const db = new DatabaseSync(config.dbPath);
  const nowIso = new Date().toISOString();

  const report: IndexReport = {
    scanned: 0,
    added: 0,
    changed: 0,
    removed: 0,
    renamed: 0,
    unchanged: 0,
    unresolvedLinks: 0,
    errors: [],
    durationMs: 0,
  };

  try {
    applySchema(db);
    db.prepare(
      `INSERT INTO sources (id, source_type, location) VALUES (?, 'obsidian', ?)
       ON CONFLICT(id) DO NOTHING`,
    ).run(OBSIDIAN_SOURCE_ID, config.vaultPath);

    const rules = loadIgnoreRules(config.vaultPath);

    const entries: FileEntry[] = [];
    for (const file of scanVault(config.vaultPath, rules)) {
      try {
        entries.push({
          relPath: file.relPath,
          absPath: file.absPath,
          hash: sha256(readFileSync(file.absPath)),
        });
      } catch (err) {
        report.errors.push({
          path: file.relPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    report.scanned = entries.length;

    const existing = db
      .prepare("SELECT id, path, hash FROM documents")
      .all() as unknown as ExistingDoc[];
    const existingByPath = new Map(existing.map((d) => [d.path, d]));
    const scannedPaths = new Set(entries.map((e) => posixify(e.relPath)));

    const goneDocs = existing.filter(
      (d) => !scannedPaths.has(d.path),
    );

    const toProcess: FileEntry[] = [];
    const renames: Array<{ entry: FileEntry; oldPath: string }> = [];

    const goneByHash = new Map<string, ExistingDoc[]>();
    for (const doc of goneDocs) {
      const list = goneByHash.get(doc.hash) ?? [];
      list.push(doc);
      goneByHash.set(doc.hash, list);
    }

    for (const entry of entries) {
      const relPosix = posixify(entry.relPath);
      const prior = existingByPath.get(relPosix);

      if (!prior) {
        const candidates = goneByHash.get(entry.hash);
        const renameSource = candidates?.shift();
        if (renameSource) {
          renames.push({ entry, oldPath: renameSource.path });
          continue;
        }
        toProcess.push(entry);
      } else if (prior.hash !== entry.hash) {
        toProcess.push(entry);
      } else {
        report.unchanged++;
      }
    }

    db.exec("BEGIN");
    try {
      for (const { entry, oldPath } of renames) {
        const relPosix = posixify(entry.relPath);
        db.prepare("UPDATE documents SET path = ?, indexed_at = ? WHERE path = ?").run(
          relPosix,
          nowIso,
          oldPath,
        );
        report.renamed++;
      }
      const renamedOldPaths = new Set(renames.map((r) => r.oldPath));
      for (const doc of goneDocs) {
        if (renamedOldPaths.has(doc.path)) continue;
        db.prepare("DELETE FROM relations WHERE origin_document_id = ?").run(doc.id);
        db.prepare("DELETE FROM entities WHERE origin_document_id = ?").run(doc.id);
        db.prepare("DELETE FROM documents_fts WHERE doc_id = ?").run(doc.id);
        db.prepare("DELETE FROM documents WHERE id = ?").run(doc.id);
        report.removed++;
      }
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw err;
    }

    const insertDoc = db.prepare(
      `INSERT INTO documents (id, path, title, type, hash, created_at, modified_at, indexed_at, content_length, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         id = excluded.id,
         title = excluded.title,
         type = excluded.type,
         hash = excluded.hash,
         created_at = excluded.created_at,
         modified_at = excluded.modified_at,
         indexed_at = excluded.indexed_at,
         content_length = excluded.content_length,
         metadata = excluded.metadata`,
    );
    const insertChunk = db.prepare(
      "INSERT INTO chunks (document_id, ordinal, heading, content) VALUES (?, ?, ?, ?)",
    );
    const insertFts = db.prepare(
      "INSERT INTO documents_fts (doc_id, title, body, tags, aliases, headings) VALUES (?, ?, ?, ?, ?, ?)",
    );
    const upsertEntity = db.prepare(
      `INSERT INTO entities (id, canonical_name, type, status, aliases, metadata, source_id, origin_document_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         canonical_name = excluded.canonical_name,
         type = excluded.type,
         status = excluded.status,
         aliases = excluded.aliases,
         metadata = excluded.metadata,
         source_id = excluded.source_id,
         origin_document_id = excluded.origin_document_id,
         updated_at = excluded.updated_at`,
    );

    const KNOWN_FM_KEYS = new Set([
      "id", "type", "title", "status", "tags", "aliases",
      "created_at", "updated_at", "relations",
    ]);

    const processed: ProcessedNote[] = [];

    for (const entry of toProcess) {
      const relPosix = posixify(entry.relPath);
      try {
        const raw = readFileSync(entry.absPath, "utf8");
        const note = parseMarkdown(raw, entry.relPath);
        const docId =
          note.id ?? `doc.${sha256(relPosix).slice(0, 16)}`;

        const stats = statSync(entry.absPath);
        const createdAt = note.createdAt ?? stats.birthtime.toISOString();
        const modifiedAt = note.updatedAt ?? stats.mtime.toISOString();

        const extraMetadata: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(note.frontmatter)) {
          if (!KNOWN_FM_KEYS.has(key)) extraMetadata[key] = value;
        }

        const priorRow = db
          .prepare("SELECT id FROM documents WHERE path = ?")
          .get(relPosix) as { id: string } | undefined;
        const prevDocId =
          priorRow && priorRow.id !== docId ? priorRow.id : undefined;

        db.exec("BEGIN");
        try {
          if (prevDocId) {
            db.prepare("DELETE FROM relations WHERE origin_document_id = ?").run(prevDocId);
            db.prepare("DELETE FROM chunks WHERE document_id = ?").run(prevDocId);
            db.prepare("DELETE FROM documents_fts WHERE doc_id = ?").run(prevDocId);
          }

          insertDoc.run(
            docId,
            relPosix,
            note.title,
            note.type ?? inferFolderType(entry.relPath) ?? null,
            entry.hash,
            createdAt,
            modifiedAt,
            nowIso,
            Buffer.byteLength(raw, "utf8"),
            JSON.stringify({
              tags: note.tags,
              aliases: note.aliases,
              headings: note.headings.length,
              wikiLinks: note.wikiLinks.length,
              ...(Object.keys(extraMetadata).length > 0 ? { fm: extraMetadata } : {}),
            }),
          );

          db.prepare("DELETE FROM chunks WHERE document_id = ?").run(docId);
          db.prepare("DELETE FROM documents_fts WHERE doc_id = ?").run(docId);

          const chunks = chunkBody(note.body, note.title);
          for (const chunk of chunks) {
            insertChunk.run(docId, chunk.ordinal, chunk.heading, chunk.content);
          }

          insertFts.run(
            docId,
            note.title,
            note.body,
            note.tags.join(" "),
            note.aliases.join(", "),
            [...new Set(note.headings.map((h) => h.text))].join(" · "),
          );

          let entityId: string | undefined;
          if (note.id) {
            upsertEntity.run(
              note.id,
              note.title,
              note.type ?? inferFolderType(entry.relPath) ?? "knowledge",
              note.status ?? null,
              JSON.stringify(note.aliases),
              JSON.stringify(extraMetadata),
              OBSIDIAN_SOURCE_ID,
              docId,
              nowIso,
              nowIso,
            );
            entityId = note.id;
          }

          db.exec("COMMIT");

          processed.push({ docId, entityId, note });
          const wasChanged =
            existingByPath.get(relPosix) !== undefined &&
            existingByPath.get(relPosix)?.hash !== entry.hash;
          if (wasChanged) report.changed++;
          else report.added++;
        } catch (err) {
          try {
            db.exec("ROLLBACK");
          } catch {}
          throw err;
        }
      } catch (err) {
        report.errors.push({
          path: entry.relPath,
          error: err instanceof Error ? err.message : String(err),
        });
        log.warn("failed to index", { path: entry.relPath });
      }
    }

    interface ResolutionMaps {
      ids: Set<string>;
      aliasToId: Map<string, string>;
      nameToId: Map<string, string>;
      pathToEntityId: Map<string, string>;
    }

    const maps: ResolutionMaps = {
      ids: new Set(),
      aliasToId: new Map(),
      nameToId: new Map(),
      pathToEntityId: new Map(),
    };

    const entityRows = db
      .prepare("SELECT id, canonical_name, aliases FROM entities")
      .all() as unknown as Array<{
      id: string;
      canonical_name: string;
      aliases: string;
    }>;
    for (const e of entityRows) {
      maps.ids.add(e.id);
      maps.nameToId.set(e.canonical_name.toLowerCase(), e.id);
      try {
        for (const alias of JSON.parse(e.aliases) as unknown[]) {
          if (typeof alias === "string" && alias.trim() !== "") {
            maps.aliasToId.set(alias.toLowerCase(), e.id);
          }
        }
      } catch {}
    }
    const docEntityRows = db
      .prepare(
        `SELECT d.path AS p, e.id AS eid FROM documents d
         JOIN entities e ON e.origin_document_id = d.id`,
      )
      .all() as unknown as Array<{ p: string; eid: string }>;
    for (const row of docEntityRows) {
      const norm = posixify(row.p).toLowerCase();
      const noExt = norm.replace(/\.(md|markdown)$/, "");
      maps.pathToEntityId.set(norm, row.eid);
      maps.pathToEntityId.set(noExt, row.eid);
      const base = noExt.split("/").pop();
      if (base) maps.pathToEntityId.set(base, row.eid);
    }

    function resolveTarget(rawTarget: string): string | undefined {
      const firstPart = rawTarget.trim().split("#")[0] ?? "";
      const withoutHeading = firstPart.trim();
      if (withoutHeading === "") return undefined;
      if (maps.ids.has(withoutHeading)) return withoutHeading;
      const lower = withoutHeading.toLowerCase();
      return (
        maps.aliasToId.get(lower) ??
        maps.nameToId.get(lower) ??
        maps.pathToEntityId.get(lower) ??
        [...maps.pathToEntityId.entries()].find(
          ([key]) => key.endsWith("/" + lower),
        )?.[1]
      );
    }

    const deleteDocRelations = db.prepare(
      "DELETE FROM relations WHERE origin_document_id = ?",
    );
    const insertRelation = db.prepare(
      `INSERT INTO relations (source_entity, relation_type, target_entity, confidence, valid_from, source_id, origin_document_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const item of processed) {
      if (!item.entityId) continue;
      deleteDocRelations.run(item.docId);

      for (const rel of item.note.explicitRelations) {
        const target = resolveTarget(rel.target);
        if (!target || target === item.entityId) {
          if (!target) report.unresolvedLinks++;
          continue;
        }
        insertRelation.run(
          item.entityId,
          rel.type.toUpperCase(),
          target,
          0.95,
          null,
          OBSIDIAN_SOURCE_ID,
          item.docId,
        );
      }

      for (const link of item.note.wikiLinks) {
        const target = resolveTarget(link.target);
        if (!target || target === item.entityId) {
          if (!target) report.unresolvedLinks++;
          continue;
        }
        insertRelation.run(
          item.entityId,
          "LINKS_TO",
          target,
          0.85,
          null,
          OBSIDIAN_SOURCE_ID,
          item.docId,
        );
      }
    }

    db.prepare(
      `INSERT INTO events (event_type, subject, payload) VALUES ('vault.indexed', 'vault', ?)`,
    ).run(
      JSON.stringify({
        added: report.added,
        changed: report.changed,
        removed: report.removed,
        renamed: report.renamed,
        unchanged: report.unchanged,
        unresolvedLinks: report.unresolvedLinks,
        errors: report.errors.length,
      }),
    );

    db.prepare(
      `INSERT INTO index_metadata (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run("last_indexed_at", nowIso);

    report.durationMs = Date.now() - startedAt;
    log.info("vault indexed", {
      scanned: report.scanned,
      added: report.added,
      changed: report.changed,
      removed: report.removed,
      renamed: report.renamed,
      unchanged: report.unchanged,
      errors: report.errors.length,
      ms: report.durationMs,
    });
    return report;
  } finally {
    db.close();
  }
}

export function defaultIgnoreRulesForTests(vaultPath: string): IgnoreRule[] {
  return loadIgnoreRules(vaultPath);
}
