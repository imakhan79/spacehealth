// Nutrition and hydration targets and a quick-add catalogue. Calcium, vitamin D
// and protein matter extra in microgravity (bone and muscle loss); hydration is
// easy to neglect because thirst is blunted. Demo-grade values.

export interface Nutrients {
  kcal: number;
  protein_g: number;
  calcium_mg: number;
  vitamin_d_iu: number;
  water_ml: number;
}

export const TARGETS: Nutrients = { kcal: 2800, protein_g: 100, calcium_mg: 1200, vitamin_d_iu: 800, water_ml: 2500 };

export const NUTRIENT_LABEL: Record<keyof Nutrients, { label: string; unit: string }> = {
  kcal: { label: "Energy", unit: "kcal" },
  protein_g: { label: "Protein", unit: "g" },
  calcium_mg: { label: "Calcium", unit: "mg" },
  vitamin_d_iu: { label: "Vitamin D", unit: "IU" },
  water_ml: { label: "Water", unit: "ml" },
};

export interface CatalogItem extends Nutrients {
  id: string;
  label: string;
  kind: "meal" | "water";
}

const item = (id: string, label: string, kind: "meal" | "water", n: Partial<Nutrients>): CatalogItem => ({
  id, label, kind, kcal: 0, protein_g: 0, calcium_mg: 0, vitamin_d_iu: 0, water_ml: 0, ...n,
});

export const CATALOG: CatalogItem[] = [
  item("water250", "Water 250 ml", "water", { water_ml: 250 }),
  item("water500", "Water 500 ml", "water", { water_ml: 500 }),
  item("eggs", "Scrambled eggs (rehydrated)", "meal", { kcal: 260, protein_g: 18, calcium_mg: 90, vitamin_d_iu: 80, water_ml: 120 }),
  item("oatmeal", "Oatmeal with raisins", "meal", { kcal: 310, protein_g: 9, calcium_mg: 180, water_ml: 150 }),
  item("chicken", "Teriyaki chicken & rice", "meal", { kcal: 520, protein_g: 38, calcium_mg: 60, water_ml: 100 }),
  item("beef", "Beef stew", "meal", { kcal: 460, protein_g: 32, calcium_mg: 50, water_ml: 120 }),
  item("salmon", "Salmon with vegetables", "meal", { kcal: 420, protein_g: 34, calcium_mg: 120, vitamin_d_iu: 450, water_ml: 90 }),
  item("milk", "Milk drink (fortified)", "meal", { kcal: 160, protein_g: 9, calcium_mg: 350, vitamin_d_iu: 120, water_ml: 230 }),
  item("tortilla", "Tortilla with peanut butter", "meal", { kcal: 380, protein_g: 12, calcium_mg: 40 }),
  item("fruit", "Dried fruit mix", "meal", { kcal: 200, protein_g: 2, calcium_mg: 40 }),
];

export function totals(logs: Partial<Nutrients>[]): Nutrients {
  const t: Nutrients = { kcal: 0, protein_g: 0, calcium_mg: 0, vitamin_d_iu: 0, water_ml: 0 };
  for (const l of logs) for (const k of Object.keys(t) as (keyof Nutrients)[]) t[k] += l[k] ?? 0;
  return t;
}

/**
 * "Behind" flags: by this hour of the (UTC) day the crew member should have
 * reached a proportional share of each target, assuming a 07:00–21:00 day.
 * Before 11:00 nothing is flagged (too early to tell).
 */
export function behind(t: Nutrients, nowHourUtc: number): (keyof Nutrients)[] {
  if (nowHourUtc < 11) return [];
  const share = Math.min(1, Math.max(0, (nowHourUtc - 7) / 14));
  return (Object.keys(TARGETS) as (keyof Nutrients)[]).filter((k) => t[k] < TARGETS[k] * share * 0.7);
}
