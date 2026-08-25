/**
 * Deterministic nutrition engines — CODE FIRST, no AI.
 * All calculations are pure functions over the structured foods table.
 * Per Nutriva spec: AI never decides nutritional results.
 */
import { DatabaseSync } from "node:sqlite";

export interface FoodRow {
  id: number;
  name: string;
  category: string;
  unit: string;
  reference_weight: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface NutritionTotals {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Scale a food's nutrition to the requested quantity.
 *  - unit "unidade": stated values are PER SINGLE UNIT (factor = quantity)
 *  - otherwise (g/ml): values are per reference_weight (factor = quantity / ref) */
export function calculateItemNutrition(food: FoodRow, quantity: number): NutritionTotals {
  const factor = food.unit === "unidade" ? quantity : quantity / (food.reference_weight || 100);
  return {
    kcal: round2(food.kcal * factor),
    protein: round2(food.protein * factor),
    carbs: round2(food.carbs * factor),
    fat: round2(food.fat * factor),
  };
}

export function sumTotals(parts: NutritionTotals[]): NutritionTotals {
  return parts.reduce(
    (acc, p) => ({
      kcal: round2(acc.kcal + p.kcal),
      protein: round2(acc.protein + p.protein),
      carbs: round2(acc.carbs + p.carbs),
      fat: round2(acc.fat + p.fat),
    }),
    { kcal: 0, protein: 0, carbs: 0, fat: 0 },
  );
}

export interface MealInput { name?: string; items: Array<{ foodId: number; quantity: number }> }
export interface MealResult extends NutritionTotals { name?: string; items: Array<{ foodId: number; foodName: string; quantity: number; unit: string } & NutritionTotals> }

/** Calculate full plan: per-item, per-meal and daily totals. */
export function calculatePlan(db: DatabaseSync, meals: MealInput[]): { meals: MealResult[]; daily: NutritionTotals } {
  const getFood = db.prepare("SELECT id, name, category, unit, reference_weight, kcal, protein, carbs, fat FROM foods WHERE id = ?");
  const results: MealResult[] = [];
  for (const meal of meals) {
    const items: MealResult["items"] = [];
    for (const item of meal.items) {
      const food = getFood.get(item.foodId) as FoodRow | undefined;
      if (!food) continue;
      const totals = calculateItemNutrition(food, item.quantity);
      items.push({ foodId: food.id, foodName: food.name, quantity: item.quantity, unit: food.unit, ...totals });
    }
    const mealTotals = sumTotals(items);
    results.push({ name: meal.name, items, ...mealTotals });
  }
  const daily = sumTotals(results.map((m) => ({ kcal: m.kcal, protein: m.protein, carbs: m.carbs, fat: m.fat })));
  return { meals: results, daily };
}

export type SubstitutionCandidate = { foodId: number; name: string; category: string; suggestedQuantity: number; unit: string; similarity: number } & NutritionTotals;
export interface SubstitutionResult {
  original: FoodRow | null;
  list: SubstitutionCandidate[];
}

/**
 * Substitution engine (algorithmic, per spec section 18):
 * rank same-category foods by nutritional similarity (normalized per 100g),
 * then compute the equivalent quantity that matches the ORIGINAL's protein content.
 */
export function findSubstitutions(db: DatabaseSync, foodId: number, quantity: number, limit = 5): SubstitutionResult {
  const getFood = db.prepare("SELECT id, name, category, unit, reference_weight, kcal, protein, carbs, fat FROM foods WHERE id = ?") as unknown as { get: (id: number) => FoodRow | undefined };
  const original = getFood.get(foodId);
  if (!original) return { original: null, list: [] };

  const candidates = db.prepare(
    "SELECT id, name, category, unit, reference_weight, kcal, protein, carbs, fat FROM foods WHERE category = ? AND id != ?"
  ).all(original.category, foodId) as never as FoodRow[];

  // Normalize original per 100g for comparison
  const norm = (f: FoodRow) => ({
    kcal: f.kcal / (f.reference_weight || 100) * 100,
    protein: f.protein / (f.reference_weight || 100) * 100,
    carbs: f.carbs / (f.reference_weight || 100) * 100,
    fat: f.fat / (f.reference_weight || 100) * 100,
  });
  const o = norm(original);

  const scored = candidates.map((c) => {
    const n = norm(c);
    // Weighted euclidean distance: protein matters most (spec), then carbs, fat, kcal
    const dist = Math.sqrt(
      3 * (o.protein - n.protein) ** 2 +
      1 * (o.carbs - n.carbs) ** 2 +
      1 * (o.fat - n.fat) ** 2 +
      1 * (o.kcal - n.kcal) ** 2,
    );
    const similarity = round2(Math.max(0, 1 - dist / 50));
    // Equivalent quantity: match the ORIGINAL ITEM's protein grams
    const originalProtein = calculateItemNutrition(original, quantity).protein;
    const cProteinPerUnit = c.unit === "unidade" ? c.protein : c.protein / (c.reference_weight || 100);
    const suggestedQuantity = cProteinPerUnit > 0 ? round2(originalProtein / cProteinPerUnit) : c.reference_weight;
    const totals = calculateItemNutrition(c, suggestedQuantity);
    return { foodId: c.id, name: c.name, category: c.category, suggestedQuantity, unit: c.unit, similarity, ...totals };
  });

  scored.sort((a, b) => b.similarity - a.similarity);
  return { original, list: scored.slice(0, limit) };
}

/** Recipe calculator: total from structured ingredients ÷ portions = per portion. */
export function calculateRecipe(db: DatabaseSync, ingredients: Array<{ foodId: number; quantity: number }>, portions: number): { total: NutritionTotals; perPortion: NutritionTotals; portions: number; ingredients: Array<{ foodId: number; foodName: string; quantity: number; unit: string } & NutritionTotals> } {
  const getFood = db.prepare("SELECT id, name, category, unit, reference_weight, kcal, protein, carbs, fat FROM foods WHERE id = ?");
  const parts: NutritionTotals[] = [];
  const detail: calculateRecipeDetail[] = [];
  for (const ing of ingredients) {
    const food = getFood.get(ing.foodId) as FoodRow | undefined;
    if (!food) continue;
    const totals = calculateItemNutrition(food, ing.quantity);
    parts.push(totals);
    detail.push({ foodId: food.id, foodName: food.name, quantity: ing.quantity, unit: food.unit, ...totals });
  }
  const total = sumTotals(parts);
  const n = portions > 0 ? portions : 1;
  return {
    total,
    perPortion: {
      kcal: round2(total.kcal / n),
      protein: round2(total.protein / n),
      carbs: round2(total.carbs / n),
      fat: round2(total.fat / n),
    },
    portions: n,
    ingredients: detail,
  };
}

type calculateRecipeDetail = { foodId: number; foodName: string; quantity: number; unit: string } & NutritionTotals;
