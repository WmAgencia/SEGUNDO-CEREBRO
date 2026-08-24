import { DatabaseSync } from "node:sqlite";

export function initNutrivaSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tenants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      crn TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'nutritionist',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      name TEXT NOT NULL,
      phone TEXT,
      birth_date TEXT,
      gender TEXT,
      height_cm REAL,
      weight_kg REAL,
      goal TEXT,
      comorbidities TEXT DEFAULT '[]',
      restrictions TEXT DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_patients_tenant ON patients(tenant_id);

    CREATE TABLE IF NOT EXISTS foods (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'general',
      unit TEXT NOT NULL DEFAULT 'g',
      reference_weight REAL NOT NULL DEFAULT 100,
      kcal REAL NOT NULL DEFAULT 0,
      protein REAL NOT NULL DEFAULT 0,
      carbs REAL NOT NULL DEFAULT 0,
      fat REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_foods_name ON foods(name);

    CREATE TABLE IF NOT EXISTS meal_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL REFERENCES tenants(id),
      patient_id INTEGER NOT NULL REFERENCES patients(id),
      name TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS meal_plan_meals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id INTEGER NOT NULL REFERENCES meal_plans(id),
      name TEXT NOT NULL,
      ordinal INTEGER NOT NULL DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS meal_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meal_id INTEGER NOT NULL REFERENCES meal_plan_meals(id),
      food_id INTEGER NOT NULL REFERENCES foods(id),
      quantity REAL NOT NULL,
      unit TEXT NOT NULL DEFAULT 'g'
    );
  `);
}
