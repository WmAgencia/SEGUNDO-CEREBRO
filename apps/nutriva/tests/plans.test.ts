import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initNutrivaSchema, ensureDefaultTenant } from "../src/db/nutriva-schema.ts";
import { seedFoods } from "../src/db/foods.ts";
import { calculateItemNutrition, calculatePlan, calculateRecipe, findSubstitutions, sumTotals } from "../src/services/plans.ts";
import { persistFullPlan, getFullPlan } from "../src/db/plans-db.ts";

function setup(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  initNutrivaSchema(db);
  ensureDefaultTenant(db);
  seedFoods(db);
  return db;
}

function foodIdByName(db: DatabaseSync, name: string): number {
  const row = db.prepare("SELECT id FROM foods WHERE name = ?").get(name) as { id: number };
  return row.id;
}

describe("nutriva — motores deterministicos", () => {
  it("calcula nutricao proporcional ao peso de referencia", () => {
    const db = setup();
    const frango = db.prepare("SELECT * FROM foods WHERE name='Peito de frango grelhado'").get() as never;
    // 100g ref: 165 kcal / 31g protein. 120g -> 198 kcal / 37.2g
    const t = calculateItemNutrition(frango, 120);
    expect(t.kcal).toBe(198);
    expect(t.protein).toBe(37.2);
  });

  it("soma totais de refeicao e plano diario", () => {
    const db = setup();
    const pao = foodIdByName(db, "Pão francês");
    const ovo = foodIdByName(db, "Ovo cozido");
    const banana = foodIdByName(db, "Banana prata");
    const plan = calculatePlan(db, [
      { name: "Café da manhã", items: [{ foodId: pao, quantity: 50 }, { foodId: ovo, quantity: 2 }, { foodId: banana, quantity: 100 }] },
      { name: "Almoço", items: [{ foodId: foodIdByName(db, "Arroz branco cozido"), quantity: 150 }, { foodId: foodIdByName(db, "Peito de frango grelhado"), quantity: 120 }] },
    ]);
    expect(plan.meals).toHaveLength(2);
    // Café: pao 50g (ref25 => x2: 134kcal) + 2 ovos (144) + banana 100g (98) = 376
    expect(plan.meals[0]!.kcal).toBe(376);
    expect(plan.daily.kcal).toBeGreaterThan(plan.meals[0]!.kcal!);
    const sumCheck = sumTotals(plan.meals.map((m) => ({ kcal: m.kcal!, protein: m.protein!, carbs: m.carbs!, fat: m.fat! })));
    expect(sumCheck).toEqual(plan.daily);
  });

  it("motor de substituicoes ranqueia mesma categoria por similaridade e equilibra proteina", () => {
    const db = setup();
    const frango = foodIdByName(db, "Peito de frango grelhado");
    const r = findSubstitutions(db, frango, 120);
    expect(r.original?.name).toBe("Peito de frango grelhado");
    expect(r.list.length).toBeGreaterThan(0);
    // Todos candidatos sao da categoria proteina e nunca incluem o original
    for (const c of r.list) {
      expect(c.category).toBe("proteina");
      expect(c.foodId).not.toBe(frango);
      // Quantidade sugerida mantem proteinas proximas das do item original (37.2g)
      expect(Math.abs(c.protein - 37.2)).toBeLessThan(6);
    }
    // Ordenado por similaridade decrescente
    for (let i = 1; i < r.list.length; i++) {
      expect(r.list[i - 1]!.similarity).toBeGreaterThanOrEqual(r.list[i]!.similarity);
    }
  });

  it("calculadora de receitas divide por porcoes", () => {
    const db = setup();
    const r = calculateRecipe(
      db,
      [
        { foodId: foodIdByName(db, "Banana prata"), quantity: 100 },
        { foodId: foodIdByName(db, "Aveia em flocos"), quantity: 30 },
        { foodId: foodIdByName(db, "Ovo cozido"), quantity: 2 },
        { foodId: foodIdByName(db, "Whey protein"), quantity: 30 },
      ],
      2,
    );
    // Total = soma exata; por porcao = metade (tolerancia de arredondamento 2 casas)
    expect(r.perPortion.kcal).toBe(r.total.kcal / 2);
    expect(r.perPortion.protein).toBeCloseTo(r.total.protein / 2, 1);
    expect(r.ingredients).toHaveLength(4);
  });

  it("persiste plano completo e recarrega com refeicoes e itens", () => {
    const db = setup();
    db.prepare("INSERT INTO patients (id, tenant_id, name) VALUES (1, 1, 'Maria Silva')").run();
    const pao = foodIdByName(db, "Pão francês");
    const ovo = foodIdByName(db, "Ovo cozido");
    const planId = persistFullPlan(db, {
      patientId: 1,
      name: "Emagrecimento",
      meals: [
        { name: "Café da manhã", items: [{ foodId: pao, quantity: 50 }, { foodId: ovo, quantity: 2 }] },
        { name: "Almoço", items: [{ foodId: foodIdByName(db, "Arroz branco cozido"), quantity: 150 }] },
      ],
    });
    const full = getFullPlan(db, planId)!;
    expect(full.plan).toMatchObject({ name: "Emagrecimento", patient_name: "Maria Silva" });
    expect(full.meals).toHaveLength(2);
    const cafe = full.meals.find((m) => m.name === "Café da manhã")!;
    expect(cafe.items).toHaveLength(2);
    // valores por referencia vindos do JOIN permitem recalcular
    expect(cafe.items[0]!.food_name).toBe("Pão francês");
    expect(cafe.items[0]!.reference_weight).toBe(25);
  });
});
