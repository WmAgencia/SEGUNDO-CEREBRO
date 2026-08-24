import { describe, expect, it } from "vitest";
import {
  calculateFoodNutrition,
  calculateMealTotals,
  calculateDayTotals,
} from "../../apps/nutriva/src/services/nutrition-engine.ts";
import type { FoodItem, MealEntry } from "../../apps/nutriva/src/services/nutrition-engine.ts";

const arroz: FoodItem = { id: 1, name: "Arroz branco", category: "cereal", unit: "g", referenceWeight: 100, kcal: 128, protein: 2.5, carbs: 28, fat: 0.2 };
const frango: FoodItem = { id: 2, name: "Peito de frango", category: "proteina", unit: "g", referenceWeight: 100, kcal: 165, protein: 31, carbs: 0, fat: 3.6 };
const banana: FoodItem = { id: 3, name: "Banana", category: "fruta", unit: "g", referenceWeight: 100, kcal: 89, protein: 1.1, carbs: 23, fat: 0.3 };
const ovo: FoodItem = { id: 4, name: "Ovo", category: "proteina", unit: "unidade", referenceWeight: 50, kcal: 72, protein: 6.3, carbs: 0.4, fat: 4.8 };

describe("nutrition engine", () => {
  it("calculates nutrition for a single food", () => {
    const r = calculateFoodNutrition(arroz, 200);
    expect(r.kcal).toBe(256);
    expect(r.protein).toBe(5);
    expect(r.carbs).toBe(56);
    expect(r.fat).toBe(0.4);
  });

  it("calculates nutrition per unit (ovo = 50g reference, 2 ovos = 100g)", () => {
    const r = calculateFoodNutrition(ovo, 100);
    expect(r.kcal).toBe(144);
    expect(r.protein).toBeCloseTo(12.6, 1);
  });

  it("calculates meal totals for multiple foods", () => {
    const entries: MealEntry[] = [
      { foodId: 1, quantity: 150, unit: "g" },
      { foodId: 2, quantity: 120, unit: "g" },
    ];
    const foods = [arroz, frango];
    const t = calculateMealTotals(foods, entries);
    expect(t.kcal).toBeGreaterThan(300);
    expect(t.protein).toBeGreaterThan(35);
  });

  it("handles zero quantity", () => {
    const r = calculateFoodNutrition(frango, 0);
    expect(r.kcal).toBe(0);
  });

  it("handles negative quantity gracefully", () => {
    const r = calculateFoodNutrition(frango, -50);
    expect(r.kcal).toBeLessThanOrEqual(0);
  });

  it("day totals sum correctly", () => {
    const breakfast = { kcal: 420, protein: 20, carbs: 50, fat: 12 };
    const lunch = { kcal: 650, protein: 45, carbs: 60, fat: 18 };
    const total = calculateDayTotals([breakfast, lunch]);
    expect(total.kcal).toBe(1070);
    expect(total.protein).toBe(65);
  });

  it("returns zeros for empty meal", () => {
    const t = calculateMealTotals([], []);
    expect(t.kcal).toBe(0);
  });
});
