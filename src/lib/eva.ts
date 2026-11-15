// EVA monitoring rules: suit limits, consumable time remaining, and the cues
// the intravehicular operator acts on. Demo-grade values modelled on the US
// EMU suit (operating pressure ~29.6 kPa / 4.3 psi); a real mission uses its
// own flight rules. Pure and tested.

export const SUIT = {
  pressureNominalKpa: 29.6,
  pressureCautionKpa: 28.9,
  pressureEmergencyKpa: 26.0,
  /** A sustained fall faster than this (kPa/min) is treated as a leak. */
  leakRateKpaPerMin: 0.02,
  co2CautionMmhg: 7.6,
  co2EmergencyMmhg: 15,
  hrCaution: 160,
  hrEmergency: 180,
  /** Consumables keep this much in reserve for the trip back and contingencies. */
  reservePct: 10,
  /** "Return to airlock" when the limiting consumable is this close. */
  returnMinutes: 30,
  terminateMinutes: 15,
} as const;

/** In-suit light-exercise prebreathe before egress (demo value). */
export const PREBREATHE_MINUTES = 100;

export type Consumable = "o2" | "battery" | "feedwater" | "scrubber";
export const CONSUMABLE_LABEL: Record<Consumable, string> = {
  o2: "Oxygen",
  battery: "Battery",
  feedwater: "Cooling water",
  scrubber: "CO₂ scrubber",
};

export interface SuitSample {
  t: number; // epoch ms
  suit_pressure_kpa: number;
  co2_mmhg: number;
  o2_pct: number;
  battery_pct: number;
  feedwater_pct: number;
  scrubber_pct: number;
  heart_rate: number;
}

const FIELD: Record<Consumable, keyof SuitSample> = { o2: "o2_pct", battery: "battery_pct", feedwater: "feedwater_pct", scrubber: "scrubber_pct" };

/** Least-squares slope (units per minute) over the samples. */
export function slopePerMin(samples: SuitSample[], field: keyof SuitSample): number | null {
  if (samples.length < 3) return null;
  const xs = samples.map((s) => s.t / 60_000);
  const ys = samples.map((s) => s[field]);
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

/** Minutes until a consumable reaches its reserve at the current drain rate (null: not draining). */
export function minutesLeft(samples: SuitSample[], c: Consumable): number | null {
  const latest = samples.at(-1);
  const slope = slopePerMin(samples, FIELD[c]);
  if (!latest || slope === null || slope >= 0) return null;
  return Math.max(0, (latest[FIELD[c]] - SUIT.reservePct) / -slope);
}

export type Tone = "normal" | "caution" | "emergency";

export interface SuitAssessment {
  tone: Tone;
  cues: { tone: Exclude<Tone, "normal">; text: string }[];
  limiting: { consumable: Consumable; minutes: number } | null;
}

/** Samples ascending by time; assessment uses roughly the last 20 minutes. */
export function assessSuit(all: SuitSample[]): SuitAssessment | null {
  const latest = all.at(-1);
  if (!latest) return null;
  const recent = all.filter((s) => s.t > latest.t - 20 * 60_000);
  const cues: SuitAssessment["cues"] = [];

  const p = latest.suit_pressure_kpa;
  const pSlope = slopePerMin(recent, "suit_pressure_kpa");
  if (p < SUIT.pressureEmergencyKpa) cues.push({ tone: "emergency", text: `Suit pressure ${p.toFixed(1)} kPa: terminate EVA, return to airlock now` });
  else if (pSlope !== null && pSlope < -SUIT.leakRateKpaPerMin) cues.push({ tone: "emergency", text: `Suit pressure falling ${(-pSlope).toFixed(3)} kPa/min: possible leak, terminate EVA` });
  else if (p < SUIT.pressureCautionKpa) cues.push({ tone: "caution", text: `Suit pressure low (${p.toFixed(1)} kPa)` });

  if (latest.co2_mmhg > SUIT.co2EmergencyMmhg) cues.push({ tone: "emergency", text: `CO₂ ${latest.co2_mmhg.toFixed(1)} mmHg: terminate EVA` });
  else if (latest.co2_mmhg > SUIT.co2CautionMmhg) cues.push({ tone: "caution", text: `CO₂ ${latest.co2_mmhg.toFixed(1)} mmHg: purge, reduce workload` });

  if (latest.heart_rate > SUIT.hrEmergency) cues.push({ tone: "emergency", text: `Heart rate ${Math.round(latest.heart_rate)}: stop work and rest` });
  else if (latest.heart_rate > SUIT.hrCaution) cues.push({ tone: "caution", text: `Heart rate ${Math.round(latest.heart_rate)}: high workload, rest` });

  let limiting: SuitAssessment["limiting"] = null;
  for (const c of Object.keys(FIELD) as Consumable[]) {
    const m = minutesLeft(recent, c);
    if (m !== null && (limiting === null || m < limiting.minutes)) limiting = { consumable: c, minutes: m };
  }
  if (limiting && limiting.minutes < SUIT.terminateMinutes) cues.push({ tone: "emergency", text: `${CONSUMABLE_LABEL[limiting.consumable]} near reserve: terminate EVA` });
  else if (limiting && limiting.minutes < SUIT.returnMinutes) cues.push({ tone: "caution", text: `${CONSUMABLE_LABEL[limiting.consumable]} limits the EVA: return to airlock within ${Math.round(limiting.minutes)} min` });

  const tone: Tone = cues.some((c) => c.tone === "emergency") ? "emergency" : cues.length ? "caution" : "normal";
  return { tone, cues, limiting };
}
