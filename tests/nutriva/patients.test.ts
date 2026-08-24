import { describe, expect, it, beforeAll } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { initNutrivaSchema } from "../../apps/nutriva/src/db/nutriva-schema.ts";
import {
  createPatient,
  getPatientById,
  listPatients,
  updatePatient,
  deletePatient,
} from "../../apps/nutriva/src/services/patient-service.ts";

let db: DatabaseSync;

beforeAll(() => {
  db = new DatabaseSync(":memory:");
  initNutrivaSchema(db);
  db.prepare("INSERT INTO tenants (id, name, email) VALUES (1, 'Tenant 1', 't1@test.com')").run();
  db.prepare("INSERT INTO tenants (id, name, email) VALUES (2, 'Tenant 2', 't2@test.com')").run();
});

describe("patient service", () => {
  it("creates patient with tenant isolation", () => {
    const p = createPatient(db, 1, { name: "Maria Silva", goal: "emagrecimento" });
    expect(p.id).toBeGreaterThan(0);
    expect(p.name).toBe("Maria Silva");
    expect(p.goal).toBe("emagrecimento");
  });

  it("lists only patients from the same tenant", () => {
    createPatient(db, 1, { name: "Paciente T1" });
    createPatient(db, 2, { name: "Paciente T2" });
    const t1 = listPatients(db, 1);
    expect(t1.every((p) => p.tenantId === 1)).toBe(true);
    const t2 = listPatients(db, 2);
    expect(t2.length).toBe(1);
  });

  it("updates patient fields", () => {
    const p = createPatient(db, 1, { name: "Update Test" });
    updatePatient(db, p.id, 1, { weight_kg: 70, goal: "ganho de massa" });
    const updated = getPatientById(db, p.id);
    expect(updated.weightKg).toBe(70);
    expect(updated.goal).toBe("ganho de massa");
  });

  it("deletes patient with tenant check", () => {
    const p = createPatient(db, 1, { name: "Delete Me" });
    const deleted = deletePatient(db, p.id, 1);
    expect(deleted).toBe(true);
    expect(() => getPatientById(db, p.id)).toThrowError(/not found/);
  });
});
