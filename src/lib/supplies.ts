// Life-support consumables: usage rate, days remaining, and whether stock lasts
// to the next resupply with a safety margin.

export type Resource = "water" | "oxygen" | "food" | "co2_cartridges";

export const RESOURCES: Record<Resource, { label: string; unit: string }> = {
  water: { label: "Water", unit: "L" },
  oxygen: { label: "Oxygen", unit: "kg" },
  food: { label: "Food", unit: "crew-days" },
  co2_cartridges: { label: "CO₂ scrubber cartridges", unit: "units" },
};

/** Days until the next resupply vehicle (mission parameter for the demo). */
export const RESUPPLY_IN_DAYS = 60;
/** Stock must outlast the resupply by this margin, or it's a caution. */
export const MARGIN_DAYS = 14;

export interface Reading {
  t: number; // epoch ms
  q: number;
}

/** Usage per day from a least-squares line over the readings (positive = consumption). */
export function usagePerDay(readings: Reading[]): number | null {
  if (readings.length < 3) return null;
  const n = readings.length;
  const days = readings.map((r) => r.t / 86_400_000);
  const mx = days.reduce((a, b) => a + b, 0) / n;
  const my = readings.reduce((a, r) => a + r.q, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (days[i]! - mx) * (readings[i]!.q - my);
    den += (days[i]! - mx) ** 2;
  }
  if (den === 0) return null;
  return -num / den;
}

export interface SupplyStatus {
  latest: number;
  perDay: number | null;
  daysLeft: number | null;
  depletesAt: number | null;
  tone: "normal" | "caution" | "emergency";
  advice: string;
}

export function supplyStatus(readings: Reading[], now: number): SupplyStatus | null {
  const sorted = [...readings].sort((a, b) => a.t - b.t);
  const last = sorted.at(-1);
  if (!last) return null;
  const perDay = usagePerDay(sorted.filter((r) => r.t > now - 7 * 86_400_000));
  if (perDay === null || perDay <= 0) {
    return { latest: last.q, perDay, daysLeft: null, depletesAt: null, tone: "normal", advice: "Not being consumed" };
  }
  const daysLeft = last.q / perDay;
  const tone = daysLeft < RESUPPLY_IN_DAYS ? "emergency" : daysLeft < RESUPPLY_IN_DAYS + MARGIN_DAYS ? "caution" : "normal";
  const advice =
    tone === "emergency"
      ? `Runs out ${Math.ceil(RESUPPLY_IN_DAYS - daysLeft)} days before resupply: ration now`
      : tone === "caution"
        ? `Lasts to resupply with only ${Math.floor(daysLeft - RESUPPLY_IN_DAYS)} days margin`
        : `Lasts ${Math.floor(daysLeft - RESUPPLY_IN_DAYS)} days past resupply`;
  return { latest: last.q, perDay, daysLeft, depletesAt: last.t + daysLeft * 86_400_000, tone, advice };
}
