import { DatabaseSync } from "node:sqlite";

export interface TenantRecord {
  id: number;
  name: string;
  email: string;
  crn: string | null;
  status: string;
}

export function createTenant(
  db: DatabaseSync,
  input: { name: string; email: string; crn?: string },
): TenantRecord {
  const inserted = db
    .prepare("INSERT INTO tenants (name, email, crn, status) VALUES (?, ?, ?, 'active')")
    .run(input.name, input.email, input.crn ?? null);
  return getTenant(db, Number(inserted.lastInsertRowid));
}

export function getTenant(db: DatabaseSync, id: number): TenantRecord {
  const row = db.prepare("SELECT * FROM tenants WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`tenant not found: ${id}`);
  return mapTenant(row);
}

export function listTenants(db: DatabaseSync): TenantRecord[] {
  return (db.prepare("SELECT * FROM tenants ORDER BY id").all() as unknown as Array<Record<string, unknown>>).map(mapTenant);
}

function mapTenant(row: Record<string, unknown>): TenantRecord {
  return {
    id: Number(row.id),
    name: String(row.name),
    email: String(row.email),
    crn: row.crn ? String(row.crn) : null,
    status: String(row.status ?? "active"),
  };
}
