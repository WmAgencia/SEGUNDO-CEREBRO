import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initNutrivaSchema } from "./db/nutriva-schema.ts";
import { seedFoods, searchFoods } from "./db/foods.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, "..", "..", "..", "data", "nutriva.db");
const db = new DatabaseSync(dbPath);
initNutrivaSchema(db);
seedFoods(db);

const PORT = Number(process.env.NUTRIVA_PORT ?? "3100");

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); } catch { resolve({}); }
    });
  });
}

const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "", `http://localhost:${PORT}`);
  const route = url.pathname;
  const method = req.method ?? "GET";

  try {
    if (method === "GET" && route === "/health") {
      json(res, 200, { status: "ok", product: "nutriva", version: "0.1.0" });
      return;
    }

    // FOODS
    if (method === "GET" && route === "/api/foods/search") {
      const query = url.searchParams.get("q") ?? "";
      json(res, 200, searchFoods(db, query));
      return;
    }

    // PATIENTS
    if (method === "GET" && route === "/api/patients") {
      const rows = db.prepare(
        `SELECT p.*, t.name AS tenant_name FROM patients p JOIN tenants t ON t.id = p.tenant_id ORDER BY p.name`
      ).all();
      json(res, 200, rows);
      return;
    }

    if (method === "POST" && route === "/api/patients") {
      const b = await readBody(req);
      const result = db.prepare(
        `INSERT INTO patients (tenant_id, name, phone, birth_date, gender, height_cm, weight_kg, goal)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(b.tenant_id ?? 1, b.name, b.phone ?? null, b.birth_date ?? null, b.gender ?? null, b.height_cm ?? null, b.weight_kg ?? null, b.goal ?? null);
      const patient = db.prepare("SELECT * FROM patients WHERE id = ?").get(result.lastInsertRowid);
      json(res, 201, patient);
      return;
    }

    // MEAL PLANS
    if (method === "GET" && route.startsWith("/api/patients/") && route.includes("/plans")) {
      const patientId = Number(route.split("/")[3]);
      const plans = db.prepare("SELECT * FROM meal_plans WHERE patient_id = ?").all(patientId);
      json(res, 200, plans);
      return;
    }

    if (method === "POST" && route === "/api/plans") {
      const b = await readBody(req);
      const plan = db.prepare(
        "INSERT INTO meal_plans (tenant_id, patient_id, name) VALUES (?, ?, ?)"
      ).run(b.tenant_id ?? 1, b.patient_id, b.name ?? "Plano alimentar");
      db.prepare(
        `INSERT INTO meal_plan_meals (plan_id, name, ordinal) VALUES (?, 'Café da manhã', 1)`
      ).run(plan.lastInsertRowid);
      const created = db.prepare("SELECT * FROM meal_plans WHERE id = ?").get(plan.lastInsertRowid);
      json(res, 201, created);
      return;
    }

    json(res, 404, { error: "not found" });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`nutriva server on :${PORT}`);
});
