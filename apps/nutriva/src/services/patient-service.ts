import { DatabaseSync } from "node:sqlite";

export interface PatientRecord {
  id: number;
  tenantId: number;
  name: string;
  phone: string | null;
  birthDate: string | null;
  gender: string | null;
  heightCm: number | null;
  weightKg: number | null;
  goal: string | null;
  status: string;
}

export function createPatient(
  db: DatabaseSync,
  tenantId: number,
  input: {
    name: string; phone?: string; birth_date?: string; gender?: string;
    height_cm?: number; weight_kg?: number; goal?: string;
  },
): PatientRecord {
  if (!input.name?.trim()) throw new Error("name is required");
  const inserted = db.prepare(
    `INSERT INTO patients (tenant_id, name, phone, birth_date, gender, height_cm, weight_kg, goal)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(tenantId, input.name.trim(), input.phone ?? null, input.birth_date ?? null,
       input.gender ?? null, input.height_cm ?? null, input.weight_kg ?? null, input.goal ?? null);
  return getPatientById(db, Number(inserted.lastInsertRowid));
}

export function getPatientById(db: DatabaseSync, id: number): PatientRecord {
  const row = db.prepare("SELECT * FROM patients WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`patient not found: ${id}`);
  return mapPatient(row);
}

export function listPatients(db: DatabaseSync, tenantId: number): PatientRecord[] {
  return (db.prepare(
    "SELECT * FROM patients WHERE tenant_id = ? ORDER BY name"
  ).all(tenantId) as unknown as Array<Record<string, unknown>>).map(mapPatient);
}

export function updatePatient(
  db: DatabaseSync, id: number, tenantId: number,
  patch: Partial<{ name: string; phone: string; weight_kg: number; goal: string; status: string }>,
): PatientRecord {
  const sets: string[] = [];
  const vals: Array<string | number | null> = [];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = ?`);
    vals.push(value);
  }
  if (sets.length > 0) {
    db.prepare(`UPDATE patients SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`)
      .run(...vals, id, tenantId);
  }
  return getPatientByIdAndTenant(db, id, tenantId);
}

export function deletePatient(db: DatabaseSync, id: number, tenantId: number): boolean {
  const result = db.prepare("DELETE FROM patients WHERE id = ? AND tenant_id = ?").run(id, tenantId);
  return result.changes > 0;
}

function getPatientByIdAndTenant(db: DatabaseSync, id: number, tenantId: number): PatientRecord {
  const row = db.prepare("SELECT * FROM patients WHERE id = ? AND tenant_id = ?").get(id, tenantId) as
    Record<string, unknown> | undefined;
  if (!row) throw new Error(`patient not found: ${id} for tenant ${tenantId}`);
  return mapPatient(row);
}

function mapPatient(row: Record<string, unknown>): PatientRecord {
  return {
    id: Number(row.id),
    tenantId: Number(row.tenant_id),
    name: String(row.name),
    phone: row.phone ? String(row.phone) : null,
    birthDate: row.birth_date ? String(row.birth_date) : null,
    gender: row.gender ? String(row.gender) : null,
    heightCm: row.height_cm ? Number(row.height_cm) : null,
    weightKg: row.weight_kg ? Number(row.weight_kg) : null,
    goal: row.goal ? String(row.goal) : null,
    status: String(row.status ?? "active"),
  };
}
