import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initNutrivaSchema } from "./db/nutriva-schema.ts";
import { seedFoods, searchFoods } from "./db/foods.ts";
import { calculatePlan, calculateRecipe, findSubstitutions, type MealInput } from "./services/plans.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.NUTRIVA_DB_PATH ?? path.join(__dirname, "..", "..", "..", "data", "nutriva.db");
export const db = new DatabaseSync(dbPath);
initNutrivaSchema(db);
seedFoods(db);

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      try { resolve(JSON.parse(body) as Record<string, unknown>); } catch { resolve({} as Record<string, unknown>); }
    });
  });
}

/** Route handler — exported so the HQ backend can mount it under /nutriva/*. */
export async function handleNutrivaRequest(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
  const url = new URL(req.url ?? "", "http://localhost");
  const route = pathname ?? url.pathname;
  const method = req.method ?? "GET";

  if (method === "GET" && (route === "/health" || route === "/api/health")) {
    json(res, 200, { status: "ok", product: "nutriva", version: "0.2.0", engines: ["plans", "substitutions", "recipes"] });
    return;
  }

  // FOODS
  if (method === "GET" && route === "/api/foods/search") {
    json(res, 200, searchFoods(db, url.searchParams.get("q") ?? ""));
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
    const s = (v: unknown): string | null => (v == null ? null : String(v));
    const num = (v: unknown): number | null => (v == null || v === "" ? null : Number(v));
    const result = db.prepare(
      `INSERT INTO patients (tenant_id, name, phone, birth_date, gender, height_cm, weight_kg, goal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(num(b.tenant_id) ?? 1, s(b.name), s(b.phone), s(b.birth_date), s(b.gender), num(b.height_cm), num(b.weight_kg), s(b.goal));
    json(res, 201, db.prepare("SELECT * FROM patients WHERE id = ?").get(result.lastInsertRowid));
    return;
  }

  // MEAL PLANS
  if (method === "GET" && route.startsWith("/api/patients/") && route.includes("/plans")) {
    const patientId = Number(route.split("/")[3]);
    json(res, 200, db.prepare("SELECT * FROM meal_plans WHERE patient_id = ?").all(patientId));
    return;
  }

  if (method === "POST" && route === "/api/plans") {
    const b = await readBody(req);
    const plan = db.prepare(
      "INSERT INTO meal_plans (tenant_id, patient_id, name) VALUES (?, ?, ?)"
    ).run(Number(b.tenant_id ?? 1), Number(b.patient_id), String(b.name ?? "Plano alimentar"));
    db.prepare(`INSERT INTO meal_plan_meals (plan_id, name, ordinal) VALUES (?, 'Café da manhã', 1)`).run(plan.lastInsertRowid);
    json(res, 201, db.prepare("SELECT * FROM meal_plans WHERE id = ?").get(plan.lastInsertRowid));
    return;
  }

  // DETERMINISTIC ENGINES
  if (method === "POST" && route === "/api/plans/calculate") {
    const b = await readBody(req);
    const meals = Array.isArray(b.meals) ? (b.meals as MealInput[]) : [];
    json(res, 200, calculatePlan(db, meals));
    return;
  }

  if (method === "POST" && route === "/api/recipes/calculate") {
    const b = await readBody(req);
    const ingredients = Array.isArray(b.ingredients) ? (b.ingredients as Array<{ foodId: number; quantity: number }>) : [];
    const portions = Number(b.portions ?? 1);
    json(res, 200, calculateRecipe(db, ingredients, portions));
    return;
  }

  if (method === "GET" && route === "/api/substitutions") {
    const foodId = Number(url.searchParams.get("foodId"));
    const quantity = Number(url.searchParams.get("quantity") ?? "100");
    if (!foodId) { json(res, 400, { error: "foodId obrigatorio" }); return; }
    json(res, 200, findSubstitutions(db, foodId, quantity, Number(url.searchParams.get("limit") ?? "5")));
    return;
  }

  json(res, 404, { error: "not found" });
}

// Standalone mode: run directly with `npm run dev` / node server.ts
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const PORT = Number(process.env.NUTRIVA_PORT ?? "3100");
  createServer(async (req, res) => { await handleNutrivaRequest(req, res, new URL(req.url ?? "/", "http://x").pathname).catch(() => {}); })
    .listen(PORT, () => console.log(`nutriva server on :${PORT}`));
}
