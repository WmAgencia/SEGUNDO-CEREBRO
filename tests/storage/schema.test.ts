import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applySchema,
  getMetadata,
  openDatabase,
  setMetadata,
} from "../../storage/connection.ts";
import { SCHEMA_VERSION } from "../../storage/schema.ts";

describe("storage/schema", () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "brain-db-"));
    dbPath = path.join(dir, "brain.db");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates database with WAL and foreign keys", () => {
    const db = openDatabase(dbPath);
    const journal = db.prepare("PRAGMA journal_mode").get() as {
      journal_mode: string;
    };
    expect(journal.journal_mode).toBe("wal");
    const fk = db.prepare("PRAGMA foreign_keys").get() as {
      foreign_keys: number;
    };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });

  it("applies schema and records version (idempotent)", () => {
    const db = openDatabase(dbPath);
    applySchema(db);
    applySchema(db); // second run must not fail
    expect(getMetadata(db, "schema_version")).toBe(String(SCHEMA_VERSION));
    db.close();
  });

  it("supports FTS5 insert, match, bm25 ranking and snippet", () => {
    const db = openDatabase(dbPath);
    applySchema(db);

    db.prepare(
      `INSERT INTO documents (id, path, title, type, hash) VALUES (?, ?, ?, ?, ?)`,
    ).run("doc-1", "03 - Knowledge/vyntra.md", "Vyntra", "project", "hash-1");
    db.prepare(
      `INSERT INTO documents_fts (doc_id, title, body, tags) VALUES (?, ?, ?, ?)`,
    ).run("doc-1", "Vyntra", "Vyntra usa WhatsApp automation para vendas", "vendas");

    const hit = db
      .prepare(
        `SELECT doc_id, snippet(documents_fts, 2, '[', ']', '...', 8) AS snip,
                bm25(documents_fts) AS score
         FROM documents_fts WHERE documents_fts MATCH ?`,
      )
      .get("whatsapp") as
      | { doc_id: string; snip: string; score: number }
      | undefined;

    expect(hit).toBeDefined();
    expect(hit?.doc_id).toBe("doc-1");
    expect(hit?.snip).toContain("[WhatsApp]");
    expect(typeof hit?.score).toBe("number");
    db.close();
  });

  it("enforces foreign keys on relations", () => {
    const db = openDatabase(dbPath);
    applySchema(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO relations (source_entity, relation_type, target_entity)
           VALUES ('ghost.a', 'USES', 'ghost.b')`,
        )
        .run(),
    ).toThrowError(/FOREIGN KEY/);
    db.close();
  });

  it("cascades chunk deletion when document is removed", () => {
    const db = openDatabase(dbPath);
    applySchema(db);
    db.prepare(
      `INSERT INTO documents (id, path, title, type, hash) VALUES (?, ?, ?, ?, ?)`,
    ).run("doc-2", "04 - Ideas/x.md", "X", "idea", "hash-2");
    db.prepare(
      `INSERT INTO chunks (document_id, ordinal, content) VALUES (?, ?, ?)`,
    ).run("doc-2", 0, "conteudo");

    db.prepare(`DELETE FROM documents WHERE id = 'doc-2'`).run();

    const count = db.prepare(`SELECT COUNT(*) AS c FROM chunks`).get() as {
      c: number;
    };
    expect(count.c).toBe(0);
    db.close();
  });

  it("setMetadata upserts", () => {
    const db = openDatabase(dbPath);
    setMetadata(db, "last_indexed_at", "2026-08-23T00:00:00Z");
    setMetadata(db, "last_indexed_at", "2026-08-23T01:00:00Z");
    expect(getMetadata(db, "last_indexed_at")).toBe("2026-08-23T01:00:00Z");
    db.close();
  });

  it("rejects schema newer than supported", () => {
    const db = openDatabase(dbPath);
    setMetadata(db, "schema_version", String(SCHEMA_VERSION + 5));
    expect(() => applySchema(db)).toThrowError(/newer than supported/);
    db.close();
  });

  it("migrates a v1 database to current version", () => {
    const v1Path = path.join(dir, "v1.db");
    const raw = new DatabaseSync(v1Path);
    raw.exec(`
      CREATE TABLE index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, source_type TEXT NOT NULL, location TEXT,
        external_id TEXT, metadata TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE documents (
        id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT, type TEXT,
        hash TEXT NOT NULL, created_at TEXT, modified_at TEXT, indexed_at TEXT,
        content_length INTEGER NOT NULL DEFAULT 0, metadata TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE entities (
        id TEXT PRIMARY KEY, canonical_name TEXT NOT NULL, type TEXT NOT NULL,
        status TEXT, aliases TEXT NOT NULL DEFAULT '[]',
        metadata TEXT NOT NULL DEFAULT '{}',
        source_id TEXT REFERENCES sources(id),
        created_at TEXT, updated_at TEXT
      );
      INSERT INTO documents (id, path, hash) VALUES ('d1', 'x.md', 'h');
      INSERT INTO entities (id, canonical_name, type) VALUES ('e1', 'E', 'concept');
      INSERT INTO index_metadata (key, value) VALUES ('schema_version', '1');
    `);
    raw.close();

    const migrated = openDatabase(v1Path);
    applySchema(migrated);

    const version = getMetadata(migrated, "schema_version");
    expect(version).toBe(String(SCHEMA_VERSION));

    const cols = migrated.prepare("PRAGMA table_info(entities)").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === "origin_document_id")).toBe(true);

    const legacyEntity = migrated
      .prepare("SELECT id FROM entities WHERE id = 'e1'")
      .get();
    expect(legacyEntity).toBeDefined();
    migrated.close();
  });
});
