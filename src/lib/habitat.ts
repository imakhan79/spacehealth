// Spacecraft module layout for the habitat map, and the binning used to
// colour it. Pure; positions are on a 1000 × 330 plan.

export interface HabitatModule {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** Has an acoustic sensor (module_id in ambient_acoustics). */
  acoustic: boolean;
}

export const MODULES: HabitatModule[] = [
  { id: "airlock", name: "Airlock", x: 10, y: 90, w: 110, h: 110, acoustic: false },
  { id: "node-1", name: "Node 1", x: 130, y: 90, w: 110, h: 110, acoustic: false },
  { id: "habitat-a", name: "Habitat A (sleep)", x: 250, y: 70, w: 190, h: 150, acoustic: true },
  { id: "galley", name: "Galley", x: 450, y: 70, w: 160, h: 150, acoustic: true },
  { id: "lab", name: "Lab", x: 620, y: 70, w: 180, h: 150, acoustic: false },
  { id: "eclss-bay", name: "ECLSS bay", x: 810, y: 70, w: 180, h: 150, acoustic: true },
  { id: "shelter", name: "Storm shelter", x: 250, y: 240, w: 190, h: 80, acoustic: false },
];

/** Hatches between modules, as [fromId, toId]. */
export const HATCHES: [string, string][] = [
  ["airlock", "node-1"],
  ["node-1", "habitat-a"],
  ["habitat-a", "galley"],
  ["galley", "lab"],
  ["lab", "eclss-bay"],
  ["habitat-a", "shelter"],
];

/**
 * Five sequential classes for a magnitude. Returns 0..4, or null for no data.
 * Edges are the class boundaries (4 values, ascending).
 */
export function binOf(value: number | null, edges: [number, number, number, number]): 0 | 1 | 2 | 3 | 4 | null {
  if (value === null || !Number.isFinite(value)) return null;
  let i = 0;
  while (i < 4 && value >= edges[i]!) i++;
  return i as 0 | 1 | 2 | 3 | 4;
}

/** LAeq dBA classes: quiet sleep areas < 45, NASA continuous limit ~ 65. */
export const NOISE_EDGES: [number, number, number, number] = [45, 52, 59, 65];
/** Dose rate µSv/h classes: background ~75, caution above 250. */
export const DOSE_EDGES: [number, number, number, number] = [60, 90, 250, 2000];
