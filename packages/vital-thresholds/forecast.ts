// Early warning: is a vital that is still normal heading into its caution
// range soon? Pure and dependency-free, shared by the crew app and Mission
// Control. Advisory only: real alerts still come from the threshold rules.
import { inBand, type ChartedMetric, type MetricSpec } from "./index.ts";

export interface Sample {
  t: number; // epoch ms
  v: number;
}

export interface Forecast {
  metric: ChartedMetric;
  /** The caution boundary the trend is heading for. */
  threshold: number;
  direction: "rising" | "falling";
  /** Units per minute, from a robust fit. */
  slopePerMin: number;
  /** Minutes from the latest sample until the fitted line reaches the threshold. */
  minutesToCross: number;
  latest: number;
}

export const FORECAST = {
  windowMin: 15,
  horizonMin: 20,
  minSamples: 8,
  minSpanMin: 10,
} as const;

/**
 * Smallest per-minute slope worth warning about, per metric: below this the
 * drift is within normal sensor noise over the horizon.
 */
const MIN_SLOPE: Record<ChartedMetric, number> = {
  heart_rate: 0.5, // bpm/min
  spo2: 0.08, // %/min
  respiratory_rate: 0.15, // br/min per min
  core_body_temp: 0.01, // °C/min
};

/** Theil–Sen: median of pairwise slopes. One spike can't swing it. */
export function theilSen(samples: Sample[]): { slope: number; intercept: number } | null {
  if (samples.length < 2) return null;
  const slopes: number[] = [];
  for (let i = 0; i < samples.length; i++)
    for (let j = i + 1; j < samples.length; j++) {
      const dt = samples[j]!.t - samples[i]!.t;
      if (dt !== 0) slopes.push((samples[j]!.v - samples[i]!.v) / dt);
    }
  if (slopes.length === 0) return null;
  const slope = median(slopes);
  const intercept = median(samples.map((s) => s.v - slope * s.t));
  return { slope, intercept };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Caution edges that touch the normal range, with the side they lie on. */
function cautionEdges(spec: MetricSpec): { edge: number; direction: "rising" | "falling" }[] {
  const out: { edge: number; direction: "rising" | "falling" }[] = [];
  for (const b of spec.bands) {
    if (b.tone !== "caution") continue;
    if (b.side === "high" && b.from !== null) out.push({ edge: b.from, direction: "rising" });
    if (b.side === "low" && b.to !== null) out.push({ edge: b.to, direction: "falling" });
  }
  return out;
}

export function forecast(spec: MetricSpec, samples: Sample[], now: number): Forecast | null {
  const recent = samples.filter((s) => s.t > now - FORECAST.windowMin * 60_000 && s.t <= now).sort((a, b) => a.t - b.t);
  if (recent.length < FORECAST.minSamples) return null;
  if (recent.at(-1)!.t - recent[0]!.t < FORECAST.minSpanMin * 60_000) return null;

  const latest = recent.at(-1)!;
  // Already abnormal: the threshold alerts own that case.
  if (spec.bands.some((b) => inBand(b, latest.v))) return null;

  const fit = theilSen(recent);
  if (!fit) return null;
  const slopePerMin = fit.slope * 60_000;
  if (Math.abs(slopePerMin) < MIN_SLOPE[spec.key]) return null;

  const fittedNow = fit.intercept + fit.slope * latest.t;
  let best: Forecast | null = null;
  for (const { edge, direction } of cautionEdges(spec)) {
    if ((direction === "rising") !== slopePerMin > 0) continue;
    const minutes = (edge - fittedNow) / slopePerMin;
    if (minutes <= 0 || minutes > FORECAST.horizonMin) continue;
    if (!best || minutes < best.minutesToCross)
      best = { metric: spec.key, threshold: edge, direction, slopePerMin, minutesToCross: minutes, latest: latest.v };
  }
  return best;
}
