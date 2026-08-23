import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { BrainConfig } from "../../core/config/loader.ts";
import { indexVault } from "../../core/indexing/vault-indexer.ts";
import { applySchema, openDatabase } from "../../storage/connection.ts";

let dir: string;
let vault: string;
let dataDir: string;
let config: BrainConfig;

function write(relPath: string, content: string): void {
  const abs = path.join(vault, relPath.split("/").join(path.sep));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
}

function query<T = Record<string, unknown>>(sql: string, ...params: Array<string | number | bigint | Buffer | null>): T[] {
  const db = new DatabaseSync(config.dbPath);
  try {
    return db.prepare(sql).all(...params) as unknown as T[];
  } finally {
    db.close();
  }
}

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), "brain-indexer-"));
  vault = path.join(dir, "vault");
  dataDir = path.join(dir, "data");
  mkdirSync(vault, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  config = {
    vaultPath: vault,
    dataDir,
    dbPath: path.join(dataDir, "brain.db"),
    logLevel: "warn",
    search: { defaultLimit: 10, maxLimit: 50 },
    context: { maxChars: 12000, defaultDepth: 1, maxDepth: 3 }, ai: { baseUrl: "http://127.0.0.1:11434", model: "qwen3-1.7b" },
  };
  writeFileSync(
    path.join(vault, ".brainignore"),
    ".env\n.env.*\n**/*.pem\n**/*.key\n**/secrets/**\n.obsidian/\n",
    "utf8",
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("indexer integration", () => {
  it("indexes new files with metadata, entities, relations and fts", () => {
    write(
      "01 - Projects/vyntra.md",
      `---
id: project.vyntra
type: project
title: Vyntra
status: active
tags: [vendas]
aliases: [Vyntra CRM]
relations:
  - type: USES
    target: system.whatsapp-automation
---

# Vyntra

Plataforma comercial integrada ao [[system.whatsapp-automation|WhatsApp]].
`,
    );
    write(
      "03 - Knowledge/whatsapp-automation.md",
      `---
id: system.whatsapp-automation
type: system
title: WhatsApp Automation
aliases: [WhatsApp Automation]
---

Automação de mensagens para vendas.
`,
    );
    write(
      "01 - Projects/prospector.md",
      `---
id: project.prospector
type: project
title: Prospector
---

Veja [[Vyntra CRM]] e [[nota-que-nao-existe]].
`,
    );
    write("09 - Daily/nota-solta.md", "Nota sem frontmatter com palavra rara zigulhobo.\n");
    write(".env", "SECRET=x\n");
    write("secrets/api-key.txt", "key\n");

    const report = indexVault(config);

    expect(report.scanned).toBe(4);
    expect(report.added).toBe(4);
    expect(report.errors).toHaveLength(0);
    expect(report.unresolvedLinks).toBe(1);

    const docs = query<{ id: string; title: string; type: string }>(
      "SELECT id, title, type FROM documents ORDER BY title",
    );
    expect(docs.map((d) => d.title)).toEqual([
      "Prospector",
      "Vyntra",
      "WhatsApp Automation",
      "nota-solta",
    ]);

    const vyntraDoc = docs.find((d) => d.title === "Vyntra");
    expect(vyntraDoc?.id).toBe("project.vyntra");
    expect(vyntraDoc?.type).toBe("project");

    const entities = query<{ id: string; canonical_name: string }>(
      "SELECT id, canonical_name FROM entities ORDER BY id",
    );
    expect(entities.map((e) => e.id)).toEqual([
      "project.prospector",
      "project.vyntra",
      "system.whatsapp-automation",
    ]);
    const soltaEntity = query(
      "SELECT * FROM entities WHERE canonical_name LIKE '%solta%'",
    );
    expect(soltaEntity).toHaveLength(0);

    const usesRelation = query<{ source_entity: string; relation_type: string; target_entity: string; confidence: number }>(
      `SELECT source_entity, relation_type, target_entity, confidence
       FROM relations WHERE relation_type = 'USES'`,
    );
    expect(usesRelation).toHaveLength(1);
    const uses = usesRelation[0];
    expect(uses?.source_entity).toBe("project.vyntra");
    expect(uses?.target_entity).toBe("system.whatsapp-automation");
    expect(uses?.confidence).toBeCloseTo(0.95);

    const linkRelations = query<{ source_entity: string; target_entity: string }>(
      "SELECT source_entity, target_entity FROM relations WHERE relation_type = 'LINKS_TO'",
    );
    expect(linkRelations.some((r) => r.source_entity === "project.prospector" && r.target_entity === "project.vyntra")).toBe(true);

    const ftsHit = query<{ doc_id: string }>(
      "SELECT doc_id FROM documents_fts WHERE documents_fts MATCH 'zigulhobo'",
    );
    expect(ftsHit).toHaveLength(1);

    const chunksForVyntra = query(
      "SELECT c.* FROM chunks c JOIN documents d ON d.id = c.document_id WHERE d.id = 'project.vyntra'",
    );
    expect(chunksForVyntra.length).toBeGreaterThan(0);
  });

  it("second run without changes reports everything unchanged", () => {
    const report = indexVault(config);
    expect(report.added).toBe(0);
    expect(report.changed).toBe(0);
    expect(report.removed).toBe(0);
    expect(report.unchanged).toBe(4);
    expect(report.renamed).toBe(0);
  });

  it("detects modified files without duplicating data", () => {
    write(
      "01 - Projects/vyntra.md",
      `---
id: project.vyntra
type: project
title: Vyntra
status: active
tags: [vendas]
aliases: [Vyntra CRM]
relations:
  - type: USES
    target: system.whatsapp-automation
---

# Vyntra

Plataforma comercial integrada ao [[system.whatsapp-automation|WhatsApp]].

Nova seção com novidade quixotesca.
`,
    );

    const report = indexVault(config);
    expect(report.changed).toBe(1);
    expect(report.added).toBe(0);

    const ftsCount = query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM documents_fts WHERE doc_id = 'project.vyntra'",
    )[0]?.c;
    expect(ftsCount).toBe(1);

    const relCount = query<{ c: number }>(
      "SELECT COUNT(*) AS c FROM relations WHERE origin_document_id = 'project.vyntra'",
    )[0]?.c;
    expect(relCount).toBe(2);

    const newContent = query<{ doc_id: string }>(
      "SELECT doc_id FROM documents_fts WHERE documents_fts MATCH 'quixotesca'",
    ).map((r) => r.doc_id);
    expect(newContent).toContain("project.vyntra");
  });

  it("preserves identity when a file is renamed", () => {
    const before = query<{ id: string }>(
      "SELECT id FROM documents WHERE path LIKE '%prospector%'",
    )[0];

    const oldContent = readFileSync(
      path.join(vault, "01 - Projects", "prospector.md"),
      "utf8",
    );
    write("08 - Research/prospector-movido.md", oldContent);
    rmSync(path.join(vault, "01 - Projects", "prospector.md"));

    const report = indexVault(config);
    expect(report.renamed).toBe(1);
    expect(report.removed).toBe(0);

    const after = query<{ id: string; path: string }>(
      "SELECT id, path FROM documents WHERE path LIKE '%prospector-movido%'",
    )[0];
    expect(after?.id).toBe(before?.id);
  });

  it("detects removals and cleans derived rows", () => {
    write("09 - Daily/temporaria.md", "---\nid: note.temp\n---\nconteudo temporario zanzalim\n");

    const first = indexVault(config);
    expect(first.added).toBe(1);

    rmSync(path.join(vault, "09 - Daily", "temporaria.md"));
    const second = indexVault(config);
    expect(second.removed).toBe(1);

    expect(query("SELECT * FROM documents WHERE id = 'note.temp'")).toHaveLength(0);
    expect(query("SELECT * FROM entities WHERE id = 'note.temp'")).toHaveLength(0);
    expect(query("SELECT * FROM documents_fts WHERE doc_id = 'note.temp'")).toHaveLength(0);
    expect(query<{ c: number }>("SELECT COUNT(*) AS c FROM documents_fts WHERE documents_fts MATCH 'zanzalim'")[0]?.c).toBe(0);
  });

  it("records events and last_indexed_at", () => {
    const events = query<{ event_type: string }>(
      "SELECT event_type FROM events WHERE event_type = 'vault.indexed'",
    );
    expect(events.length).toBeGreaterThan(0);

    const meta = query<{ value: string }>(
      "SELECT value FROM index_metadata WHERE key = 'last_indexed_at'",
    )[0];
    expect(meta?.value).toBeTruthy();
  });

  it("does not index frontmatter as body (BOM regression)", () => {
    write(
      "09 - Daily/bom-note.md",
      "\uFEFF---\r\nid: note.bom\r\ntype: event\r\ntitle: BOM\r\n---\r\n\r\nConteudo visivel zanzabum.",
    );
    const report = indexVault(config);
    expect(report.added).toBeGreaterThanOrEqual(1);

    const bodyRow = query<{ body: string }>(
      "SELECT body FROM documents_fts WHERE doc_id = 'note.bom'",
    )[0];
    expect(bodyRow?.body).toBeDefined();
    expect(bodyRow?.body).not.toContain("id:");
    expect(bodyRow?.body).toContain("zanzabum");

    const entity = query(
      "SELECT id FROM entities WHERE id = 'note.bom'",
    );
    expect(entity).toHaveLength(1);

    rmSync(path.join(vault, "09 - Daily", "bom-note.md"));
    indexVault(config);
  });
});
