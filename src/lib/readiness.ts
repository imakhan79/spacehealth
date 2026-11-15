// Daily readiness: 100 minus clearly stated deductions. Deliberately simple
// and explainable: every point lost is listed with its reason, so a flight
// surgeon can see why, and disagree. Not a diagnosis.
import type { Tone } from "../../packages/vital-thresholds/index.ts";

export interface ReadinessInput {
  checkin: { sleep_hours: number; fatigue: number; mood: number; symptoms: string[] } | null;
  /** Worst tone across the member's latest vitals. */
  vitalsTone: Tone | null;
  /** Worst open (active) alert severity for the member. */
  openAlert: "emergency" | "warning" | "caution" | "advisory" | null;
  /** Mean 7-day exercise adherence share across prescribed kinds (0..1), or null. */
  exerciseShare: number | null;
  missedDosesToday: number;
}

export interface Deduction {
  points: number;
  reason: string;
}

export type ReadinessBand = "ready" | "monitor" | "review";

export interface Readiness {
  score: number;
  band: ReadinessBand;
  deductions: Deduction[];
  /** True when there's no check-in today: the score rests on vitals alone. */
  incomplete: boolean;
}

export function readiness(i: ReadinessInput): Readiness {
  const d: Deduction[] = [];
  const add = (points: number, reason: string) => points > 0 && d.push({ points, reason });

  if (i.checkin) {
    const s = i.checkin.sleep_hours;
    add(s < 5 ? 25 : s < 6 ? 15 : s < 7 ? 5 : 0, `Slept ${s} h`);
    const f = i.checkin.fatigue;
    add(f >= 5 ? 20 : f === 4 ? 12 : f === 3 ? 5 : 0, `Fatigue ${f}/5`);
    const m = i.checkin.mood;
    add(m <= 1 ? 15 : m === 2 ? 8 : 0, `Mood ${m}/5`);
    const symptoms = i.checkin.symptoms.filter((x) => x !== "none");
    add(Math.min(12, symptoms.length * 4), `${symptoms.length} symptom${symptoms.length === 1 ? "" : "s"} reported`);
  }
  add(i.vitalsTone === "emergency" ? 30 : i.vitalsTone === "caution" ? 10 : 0, `Vitals at ${i.vitalsTone} level`);
  add(i.openAlert === "emergency" ? 20 : i.openAlert === "warning" ? 10 : 0, `Open ${i.openAlert} alert`);
  if (i.exerciseShare !== null) {
    add(i.exerciseShare < 0.5 ? 10 : i.exerciseShare < 0.8 ? 5 : 0, `Exercise at ${Math.round(i.exerciseShare * 100)}% of prescription`);
  }
  add(Math.min(10, i.missedDosesToday * 5), `${i.missedDosesToday} missed dose${i.missedDosesToday === 1 ? "" : "s"} today`);

  const score = Math.max(0, 100 - d.reduce((n, x) => n + x.points, 0));
  return {
    score,
    band: score >= 80 ? "ready" : score >= 60 ? "monitor" : "review",
    deductions: d.sort((a, b) => b.points - a.points),
    incomplete: i.checkin === null,
  };
}

export const BAND_TEXT: Record<ReadinessBand, string> = {
  ready: "Ready",
  monitor: "Monitor",
  review: "Medical review",
};
