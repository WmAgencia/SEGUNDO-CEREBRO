export interface FoodItem {
  id: number;
  name: string;
  category: string;
  unit: string;
  referenceWeight: number;
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
}

export interface MealEntry {
  foodId: number;
  quantity: number;
  unit: string;
}

export interface MealTotals {
  kcal: number;
  protein: number;
  carbs: number;
  fat: number;
}

export function calculateFoodNutrition(
  food: FoodItem,
  quantity: number,
): MealTotals {
  if (food.referenceWeight <= 0) return zeros();
  const ratio = quantity / food.referenceWeight;
  return {
    kcal: round1(food.kcal * ratio),
    protein: round1(food.protein * ratio),
    carbs: round1(food.carbs * ratio),
    fat: round1(food.fat * ratio),
  };
}

export function calculateMealTotals(
  foods: FoodItem[],
  entries: MealEntry[],
): MealTotals {
  let totals = zeros();
  for (const entry of entries) {
    const food = foods.find((f) => f.id === entry.foodId);
    if (!food) continue;
    const nutrition = calculateFoodNutrition(food, entry.quantity);
    totals = addTotals(totals, nutrition);
  }
  return totals;
}

export function calculateDayTotals(meals: MealTotals[]): MealTotals {
  return meals.reduce(addTotals, zeros());
}

function addTotals(a: MealTotals, b: MealTotals): MealTotals {
  return {
    kcal: round1(a.kcal + b.kcal),
    protein: round2(a.protein + b.protein),
    carbs: round2(a.carbs + b.carbs),
    fat: round2(a.fat + b.fat),
  };
}

function zeros(): MealTotals {
  return { kcal: 0, protein: 0, carbs: 0, fat: 0 };
}
function round1(n: number): number { return Math.round(n * 10) / 10; }
function round2(n: number): number { return Math.round(n * 100) / 100; }
