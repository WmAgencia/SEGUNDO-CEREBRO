/**
 * Entity resolution policy — SEARCH EXISTING → UPDATE; senão CREATE.
 *
 * Prevents the classic mess: "Derek", "Derek 2", "Derek novo", "Derek final"
 * all pointing to the same person. Uses real resolution (id → alias → name →
 * prefix) before creating anything. Only creates when no match (or the caller
 * forces create).
 */

import type { DatabaseSync } from "node:sqlite";
import { resolveEntity } from "../entities/resolver.ts";

export interface ResolveOrCreateInput {
  name: string;
  entityType?: string;
  status?: string;
  aliases?: string[];
  metadata?: Record<string, unknown>;
}

export interface ResolveOrCreateResult {
  entityId: string;
  resolved: boolean;
  method: string;
  confidence: number;
}

/**
 * Returns an existing entity id if a confident match exists; otherwise creates
 * a new entity (stable id in the type.slug convention).
 */
export function resolveOrCreateEntity(
  db: DatabaseSync,
  input: ResolveOrCreateInput,
  opts: { forceCreate?: boolean; minConfidence?: number } = {},
): ResolveOrCreateResult {
  const minConfidence = opts.minConfidence ?? 0.7;
  const name = input.name.trim();
  if (!name) throw new Error("entity name is required");

  if (!opts.forceCreate) {
    const res = resolveEntity(db, name);
    if (res.best && res.best.confidence >= minConfidence) {
      const e = res.best.entity;
      // UPDATE: sincroniza nome/aliases canonical com o que registramos
      if (input.aliases?.length && e.aliases.length === 0) {
        db.prepare("UPDATE entities SET aliases = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
          .run(JSON.stringify([...new Set([...e.aliases, ...input.aliases])]), e.id);
      }
      return { entityId: e.id, resolved: true, method: res.best.method, confidence: res.best.confidence };
    }
  }

  const slug = name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "")
    .slice(0, 60) || "entidade";
  const id = `${input.entityType ?? "entidade"}.${slug}`;

  db.prepare(
    `INSERT INTO entities (id, canonical_name, type, status, aliases, metadata, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(id) DO UPDATE SET canonical_name = excluded.canonical_name, status = excluded.status, updated_at = excluded.updated_at`,
  ).run(
    id,
    name.slice(0, 200),
    input.entityType ?? "entidade",
    input.status ?? null,
    JSON.stringify(input.aliases ?? []),
    JSON.stringify(input.metadata ?? {}),
  );

  return { entityId: id, resolved: false, method: "create", confidence: 1 };
}

export { resolveEntity };