import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { StorageError, toBrainError } from "../core/errors/errors.ts";
import { createLogger } from "../core/logger/logger.ts";
import { SCHEMA_STATEMENTS, SCHEMA_VERSION, MIGRATIONS } from "./schema.ts";

const log = createLogger("storage");

export interface OpenDatabaseOptions {
  createDirs?: boolean;
}

export function openDatabase(
  dbPath: string,
  options: OpenDatabaseOptions = {},
): DatabaseSync {
  try {
    if (options.createDirs !== false) {
      mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    return db;
  } catch (err) {
    throw toBrainError(err);
  }
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return cols.some((c) => c.name === column);
}

function isIdempotentAddColumn(
  db: DatabaseSync,
  statement: string,
): boolean {
  const match = /^ALTER\s+TABLE\s+(\w+)\s+ADD\s+COLUMN\s+(\w+)/i.exec(statement);
  if (!match || !match[1] || !match[2]) return false;
  if (!columnExists(db, match[1], match[2])) return true;
  return false;
}

export function applySchema(db: DatabaseSync): void {
  try {
    db.exec("BEGIN");
    for (const statement of SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
    const row = db
      .prepare("SELECT value FROM index_metadata WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;

    if (!row) {
      db.prepare(
        "INSERT INTO index_metadata (key, value) VALUES ('schema_version', ?)",
      ).run(String(SCHEMA_VERSION));
    } else {
      let version = Number(row.value);
      if (version > SCHEMA_VERSION) {
        throw new StorageError(
          `database schema version ${version} is newer than supported ${SCHEMA_VERSION}`,
        );
      }
      while (version < SCHEMA_VERSION) {
        const migration = MIGRATIONS.find((m) => m.from === version);
        if (!migration) {
          throw new StorageError(
            `no migration from schema version ${version} to ${SCHEMA_VERSION}`,
          );
        }
        for (const statement of migration.statements) {
          if (isIdempotentAddColumn(db, statement)) {
            db.exec(statement);
          }
        }
        version += 1;
      }
      if (Number(row.value) !== SCHEMA_VERSION) {
        db.prepare(
          "UPDATE index_metadata SET value = ? WHERE key = 'schema_version'",
        ).run(String(SCHEMA_VERSION));
      }
    }
    db.exec("COMMIT");
    log.debug("schema applied", { version: SCHEMA_VERSION });
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // rollback may fail if transaction never opened; safe to ignore
    }
    throw toBrainError(err);
  }
}

export function getMetadata(db: DatabaseSync, key: string): string | undefined {
  const row = db
    .prepare("SELECT value FROM index_metadata WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setMetadata(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    `INSERT INTO index_metadata (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
