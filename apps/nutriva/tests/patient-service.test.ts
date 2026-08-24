import { DatabaseSync } from "node:sqlite";
import { createPatient } from "../src/services/patient-service";
import { beforeEach, test, expect } from "vitest";

const db = new DatabaseSync(":memory:");

beforeEach(() => {
  db.prepare(
    "CREATE TABLE IF NOT EXISTS patients (id INTEGER PRIMARY KEY AUTOINCREMENT, tenant_id INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT, birth_date TEXT, gender TEXT, height_cm REAL, weight_kg REAL, goal TEXT, status TEXT DEFAULT 'active')"
  ).run();
});

test("createPatient rejects empty name", () => {
  expect(() => createPatient(db, 1, { name: "" })).toThrow("patient name is required");
});

test("createPatient rejects whitespace-only name", () => {
  expect(() => createPatient(db, 1, { name: "   " })).toThrow("patient name is required");
});

test("createPatient accepts valid name", () => {
  const result = createPatient(db, 1, { name: "João Silva", phone: "12345678" });
  expect(result.name).toBe("João Silva");
  expect(result.phone).toBe("12345678");
});