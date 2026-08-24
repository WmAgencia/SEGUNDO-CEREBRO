import { DatabaseSync } from "node:sqlite";

const FOODS = [
  { name: "Arroz branco cozido", category: "cereal", unit: "g", ref: 100, kcal: 128, protein: 2.5, carbs: 28, fat: 0.2 },
  { name: "Arroz integral cozido", category: "cereal", unit: "g", ref: 100, kcal: 124, protein: 2.6, carbs: 25.8, fat: 1 },
  { name: "Aveia em flocos", category: "cereal", unit: "g", ref: 30, kcal: 117, protein: 3.9, carbs: 19.9, fat: 2.1 },
  { name: "Pão francês", category: "cereal", unit: "g", ref: 25, kcal: 67, protein: 2.1, carbs: 13, fat: 0.8 },
  { name: "Pão integral", category: "cereal", unit: "g", ref: 30, kcal: 70, protein: 2.8, carbs: 12, fat: 1.1 },
  { name: "Batata doce cozida", category: "tubérculo", unit: "g", ref: 100, kcal: 77, protein: 1.4, carbs: 18.4, fat: 0.1 },
  { name: "Batata inglesa cozida", category: "tubérculo", unit: "g", ref: 100, kcal: 52, protein: 1.2, carbs: 11.5, fat: 0 },
  { name: "Macarrão cozido", category: "cereal", unit: "g", ref: 100, kcal: 158, protein: 5.8, carbs: 30.9, fat: 0.9 },
  { name: "Feijão carioca cozido", category: "leguminosa", unit: "g", ref: 100, kcal: 76, protein: 4.8, carbs: 14.1, fat: 0.5 },
  { name: "Lentilha cozida", category: "leguminosa", unit: "g", ref: 100, kcal: 90, protein: 7.6, carbs: 16.3, fat: 0.4 },
  { name: "Peito de frango grelhado", category: "proteina", unit: "g", ref: 100, kcal: 165, protein: 31, carbs: 0, fat: 3.6 },
  { name: "Ovo cozido", category: "proteina", unit: "unidade", ref: 50, kcal: 72, protein: 6.3, carbs: 0.4, fat: 4.8 },
  { name: "Carne moída magra", category: "proteina", unit: "g", ref: 100, kcal: 187, protein: 26, carbs: 0, fat: 9 },
  { name: "Tilápia grelhada", category: "proteina", unit: "g", ref: 100, kcal: 96, protein: 20.1, carbs: 0, fat: 1.7 },
  { name: "Whey protein", category: "suplemento", unit: "g", ref: 30, kcal: 120, protein: 24, carbs: 3, fat: 1.5 },
  { name: "Leite desnatado", category: "laticínio", unit: "ml", ref: 200, kcal: 70, protein: 6.8, carbs: 9.6, fat: 0.2 },
  { name: "Iogurte natural desnatado", category: "laticínio", unit: "g", ref: 170, kcal: 56, protein: 5.8, carbs: 7.7, fat: 0.2 },
  { name: "Queijo minas frescal", category: "laticínio", unit: "g", ref: 30, kcal: 79, protein: 6.4, carbs: 1.2, fat: 5.4 },
  { name: "Banana prata", category: "fruta", unit: "g", ref: 100, kcal: 98, protein: 1.3, carbs: 26, fat: 0.1 },
  { name: "Maçã", category: "fruta", unit: "g", ref: 100, kcal: 81, protein: 0.3, carbs: 21, fat: 0.5 },
  { name: "Mamão papaia", category: "fruta", unit: "g", ref: 100, kcal: 40, protein: 0.5, carbs: 10.4, fat: 0.1 },
  { name: "Laranja pera", category: "fruta", unit: "g", ref: 100, kcal: 48, protein: 0.9, carbs: 12, fat: 0.1 },
  { name: "Abacate", category: "fruta", unit: "g", ref: 100, kcal: 96, protein: 1.2, carbs: 6, fat: 9.8 },
  { name: "Brócolis cozido", category: "vegetal", unit: "g", ref: 100, kcal: 25, protein: 2.6, carbs: 5, fat: 0.3 },
  { name: "Alface", category: "vegetal", unit: "g", ref: 50, kcal: 7, protein: 0.6, carbs: 1.2, fat: 0.1 },
  { name: "Tomate", category: "vegetal", unit: "g", ref: 100, kcal: 15, protein: 1.1, carbs: 3.1, fat: 0.2 },
  { name: "Cenoura crua", category: "vegetal", unit: "g", ref: 100, kcal: 34, protein: 1.2, carbs: 8.2, fat: 0.2 },
  { name: "Azeite de oliva", category: "gordura", unit: "ml", ref: 10, kcal: 88, protein: 0, carbs: 0, fat: 10 },
  { name: "Amendoim", category: "oleaginosa", unit: "g", ref: 30, kcal: 170, protein: 7.5, carbs: 4.5, fat: 14 },
  { name: "Castanha-do-pará", category: "oleaginosa", unit: "g", ref: 15, kcal: 99, protein: 2.2, carbs: 1.8, fat: 9.5 },
];

export function seedFoods(db: DatabaseSync): number {
  const existing = db.prepare("SELECT COUNT(*) AS c FROM foods").get() as { c: number };
  if (existing.c > 0) return 0;

  const insert = db.prepare(
    `INSERT INTO foods (name, category, unit, reference_weight, kcal, protein, carbs, fat)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let count = 0;
  for (const f of FOODS) {
    insert.run(f.name, f.category, f.unit, f.ref, f.kcal, f.protein, f.carbs, f.fat);
    count++;
  }
  return count;
}

export function searchFoods(
  db: DatabaseSync,
  query: string,
  limit = 10,
): Array<{ id: number; name: string; category: string; unit: string; reference_weight: number; kcal: number; protein: number; carbs: number; fat: number }> {
  const lower = query.toLowerCase();
  return db
    .prepare(
      `SELECT id, name, category, unit, reference_weight, kcal, protein, carbs, fat
       FROM foods WHERE LOWER(name) LIKE ?
       ORDER BY name LIMIT ?`
    )
    .all(`%${lower}%`, limit) as never[];
}
