import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { initNutrivaSchema, ensureDefaultTenant } from "./db/nutriva-schema.ts";
import { seedFoods, searchFoods } from "./db/foods.ts";
import { calculatePlan, calculateRecipe, findSubstitutions, type MealInput } from "./services/plans.ts";
import { authenticate, ensureMasterUser, verifyToken, MASTER_EMAIL } from "./services/auth.ts";
import { persistFullPlan, getFullPlan } from "./db/plans-db.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, "..", "public");
const dbPath = process.env.NUTRIVA_DB_PATH ?? path.join(__dirname, "..", "..", "..", "data", "nutriva.db");
export const db = new DatabaseSync(dbPath);
initNutrivaSchema(db);
ensureDefaultTenant(db);
seedFoods(db);
ensureMasterUser(db);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(res: ServerResponse, route: string): void {
  const rel = route === "/" ? "index.html" : route.replace(/^\//, "");
  let fp = path.join(STATIC_DIR, rel);
  // SPA fallback: missing files or extension-less routes get index.html
  if (!fp.startsWith(STATIC_DIR) || !existsSync(fp) || !path.extname(fp)) fp = path.join(STATIC_DIR, "index.html");
  const ext = path.extname(fp).toLowerCase();
  res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
  res.end(readFileSync(fp));
}

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

  if (method === "POST" && route === "/api/auth/login") {
    const b = await readBody(req);
    const result = authenticate(db, String(b.email ?? ""), String(b.password ?? ""));
    if (!result) { json(res, 401, { error: "email ou senha invalidos" }); return; }
    json(res, 200, result);
    return;
  }

  // Mutations require a valid session (GETs remain open for the demo UI)
  if (method !== "GET" && route.startsWith("/api/") && route !== "/api/auth/login") {
    const auth = req.headers.authorization ?? "";
    if (!verifyToken(auth.replace(/^Bearer /i, ""))) {
      json(res, 401, { error: "nao autenticado", loginUrl: "/?login=1" });
      return;
    }
  }

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

  if (method === "GET" && route === "/api/plans") {
    json(res, 200, db.prepare(
      `SELECT p.id, p.name, p.status, p.created_at, pt.name AS patient_name
       FROM meal_plans p JOIN patients pt ON pt.id = p.patient_id ORDER BY p.id DESC LIMIT 50`
    ).all());
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

  // DASHBOARD
  if (method === "GET" && route === "/api/dashboard") {
    const count = (sql: string): number => Number((db.prepare(sql).get() as { n: number }).n);
    json(res, 200, {
      patients: count("SELECT COUNT(*) AS n FROM patients WHERE status='active'"),
      plans: count("SELECT COUNT(*) AS n FROM meal_plans"),
      foods: count("SELECT COUNT(*) AS n FROM foods"),
      tenants: count("SELECT COUNT(*) AS n FROM tenants WHERE status='active'"),
      recentPatients: db.prepare("SELECT id, name, phone, goal, weight_kg FROM patients ORDER BY id DESC LIMIT 5").all(),
    });
    return;
  }

  // FULL PLAN PERSISTENCE
  if (method === "POST" && route === "/api/plans/full") {
    const b = await readBody(req);
    const meals = Array.isArray(b.meals) ? (b.meals as MealInput[]) : [];
    const patientId = Number(b.patient_id);
    if (!patientId || meals.length === 0) { json(res, 400, { error: "patient_id e meals sao obrigatorios" }); return; }
    try {
      const planId = persistFullPlan(db, {
        tenantId: Number(b.tenant_id ?? 1),
        patientId,
        name: typeof b.name === "string" ? b.name : "Plano alimentar",
        meals: meals.map((m) => ({ name: String(m.name ?? "Refeição"), items: m.items.map((i) => ({ foodId: Number(i.foodId), quantity: Number(i.quantity) })) })),
      });
      json(res, 201, { planId, ...getFullPlan(db, planId) });
    } catch (err) {
      json(res, 500, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  const fullPlanMatch = route.match(/^\/api\/plans\/(\d+)\/full$/);
  if (method === "GET" && fullPlanMatch) {
    const result = getFullPlan(db, Number(fullPlanMatch[1]));
    if (!result) { json(res, 404, { error: "plano nao encontrado" }); return; }
    json(res, 200, result);
    return;
  }

  // STATIC FRONTEND — any GET that is not /api/*
  if (method === "GET" && !route.startsWith("/api")) {
    serveStatic(res, route);
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
