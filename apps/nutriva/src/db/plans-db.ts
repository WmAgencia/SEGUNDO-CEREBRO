import { DatabaseSync } from "node:sqlite";

export interface FullPlanInput {
  tenantId?: number;
  patientId: number;
  name?: string;
  meals: Array<{ name: string; items: Array<{ foodId: number; quantity: number }> }>;
}

/** Persist a complete plan (plan + meals + items) atomically. Returns planId. */
export function persistFullPlan(db: DatabaseSync, input: FullPlanInput): number {
  const tenantId = input.tenantId ?? 1;
  const insertPlan = db.prepare("INSERT INTO meal_plans (tenant_id, patient_id, name, status) VALUES (?, ?, ?, 'active')");
  const insertMeal = db.prepare("INSERT INTO meal_plan_meals (plan_id, name, ordinal) VALUES (?, ?, ?)");
  const insertItem = db.prepare("INSERT INTO meal_plan_items (meal_id, food_id, quantity, unit) VALUES (?, ?, ?, ?)");
  const getFoodUnit = db.prepare("SELECT unit FROM foods WHERE id = ?");

  db.exec("BEGIN");
  try {
    const plan = insertPlan.run(tenantId, input.patientId, input.name ?? "Plano alimentar");
    const planId = Number(plan.lastInsertRowid);
    let ordinal = 1;
    for (const meal of input.meals) {
      const m = insertMeal.run(planId, meal.name || `Refeição ${ordinal}`, ordinal);
      const mealId = Number(m.lastInsertRowid);
      for (const item of meal.items) {
        const unit = (getFoodUnit.get(item.foodId) as { unit: string } | undefined)?.unit ?? "g";
        insertItem.run(mealId, item.foodId, item.quantity, unit);
      }
      ordinal++;
    }
    db.exec("COMMIT");
    return planId;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export interface FullPlanRow {
  meal_name: string;
  ordinal: number;
  food_id: number;
  food_name: string;
  food_category: string;
  food_unit: string;
  reference_weight: number;
  quantity: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

/** Load a saved plan with joined food rows so callers can recalculate deterministically. */
export function getFullPlan(db: DatabaseSync, planId: number): { plan: unknown; meals: Array<{ name: string; ordinal: number; items: FullPlanRow[] }> } | null {
  const plan = db.prepare(
    `SELECT p.*, pt.name AS patient_name FROM meal_plans p JOIN patients pt ON pt.id = p.patient_id WHERE p.id = ?`
  ).get(planId);
  if (!plan) return null;

  const rows = db.prepare(
    `SELECT m.name AS meal_name, m.ordinal,
            i.food_id, f.name AS food_name, f.category AS food_category, f.unit AS food_unit,
            f.reference_weight, i.quantity, i.unit,
            f.kcal, f.protein, f.carbs, f.fat
     FROM meal_plan_meals m
     JOIN meal_plan_items i ON i.meal_id = m.id
     JOIN foods f ON f.id = i.food_id
     WHERE m.plan_id = ?
     ORDER BY m.ordinal, i.id`
  ).all(planId) as never as FullPlanRow[];

  const meals: Array<{ name: string; ordinal: number; items: FullPlanRow[] }> = [];
  for (const r of rows) {
    let meal = meals.find((mm) => mm.name === r.meal_name);
    if (!meal) { meal = { name: r.meal_name, ordinal: r.ordinal, items: [] }; meals.push(meal); }
    meal.items.push(r);
  }
  return { plan, meals };
}
