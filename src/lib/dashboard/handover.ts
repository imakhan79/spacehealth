// Shift handover: what happened to each crew member over the shift, reduced
// to the few numbers an incoming shift needs. Pure and tested.
import { METRICS, inBand, type ChartedMetric, type MetricSpec } from "../../../packages/vital-thresholds/index.ts";

export interface Point {
  t: number;
  v: number;
}

export interface MetricSummary {
  metric: ChartedMetric;
  samples: number;
  min: number | null;
  median: number | null;
  max: number | null;
  latest: number | null;
  /** Share of samples in a caution / emergency band, 0..1. */
  cautionShare: number;
  emergencyShare: number;
}

export interface MemberShift {
  metrics: MetricSummary[];
  /** Longest stretch with no vitals at all, inside the shift. */
  longestGapMs: number;
  /** Dose added over the shift (last − first cumulative reading), mSv. */
  doseAddedMsv: number | null;
  doseLatestMsv: number | null;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function summarizeMetric(spec: MetricSpec, points: Point[]): MetricSummary {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const values = sorted.map((p) => p.v);
  let caution = 0;
  let emergency = 0;
  for (const v of values) {
    const bands = spec.bands.filter((b) => inBand(b, v));
    if (bands.some((b) => b.tone === "emergency")) emergency++;
    else if (bands.length > 0) caution++;
  }
  const n = values.length;
  return {
    metric: spec.key,
    samples: n,
    min: n ? Math.min(...values) : null,
    median: median(values),
    max: n ? Math.max(...values) : null,
    latest: n ? values[n - 1]! : null,
    cautionShare: n ? caution / n : 0,
    emergencyShare: n ? emergency / n : 0,
  };
}

/**
 * Longest stretch inside [from, to] without any sample. The stretch before
 * the first sample and after the last both count: no data is no data.
 */
export function longestGap(times: number[], from: number, to: number): number {
  const ts = times.filter((t) => t >= from && t <= to).sort((a, b) => a - b);
  if (ts.length === 0) return to - from;
  let gap = Math.max(ts[0]! - from, to - ts.at(-1)!);
  for (let i = 1; i < ts.length; i++) gap = Math.max(gap, ts[i]! - ts[i - 1]!);
  return gap;
}

export function summarizeMember(
  series: Partial<Record<ChartedMetric, Point[]>>,
  cumulativeDose: Point[],
  from: number,
  to: number,
): MemberShift {
  const metrics = METRICS.map((spec) => summarizeMetric(spec, series[spec.key] ?? []));
  const allTimes = METRICS.flatMap((m) => (series[m.key] ?? []).map((p) => p.t));
  const dose = [...cumulativeDose].filter((p) => p.t >= from && p.t <= to).sort((a, b) => a.t - b.t);
  return {
    metrics,
    longestGapMs: longestGap(allTimes, from, to),
    doseAddedMsv: dose.length >= 2 ? dose.at(-1)!.v - dose[0]!.v : null,
    doseLatestMsv: dose.at(-1)?.v ?? null,
  };
}
