// Caution / emergency ranges for the charted vitals. Shared, dependency-free,
// by the crew app (tiles + trend charts) and Mission Control (ground charts),
// so both sides of the link flag the same values.

export type Tone = "normal" | "caution" | "emergency";
export type ChartedMetric = "heart_rate" | "spo2" | "respiratory_rate" | "core_body_temp";

/**
 * A value range outside normal; null means unbounded on that side.
 * Boundaries keep the original tile rules, where a value exactly on a
 * threshold counts as the milder state: a "low" band is [from, to) and a
 * "high" band is (from, to]. So heart rate 140 is caution, 140.5 emergency;
 * SpO₂ 90 is caution, 89 emergency.
 */
export interface Band {
  tone: Exclude<Tone, "normal">;
  side: "low" | "high";
  from: number | null;
  to: number | null;
}

export interface MetricSpec {
  key: ChartedMetric;
  label: string;
  unit: string;
  digits: number;
  /** Caution and emergency ranges. Anything outside every band is normal. */
  bands: Band[];
}

// One source of truth for the tiles' colouring and the trend charts' bands.
export const METRICS: MetricSpec[] = [
  {
    key: "heart_rate",
    label: "Heart rate",
    unit: "bpm",
    digits: 0,
    bands: [
      { tone: "emergency", side: "low", from: null, to: 40 },
      { tone: "caution", side: "high", from: 110, to: 140 },
      { tone: "emergency", side: "high", from: 140, to: null },
    ],
  },
  {
    key: "spo2",
    label: "SpO₂",
    unit: "%",
    digits: 0,
    bands: [
      { tone: "emergency", side: "low", from: null, to: 90 },
      { tone: "caution", side: "low", from: 90, to: 94 },
    ],
  },
  {
    key: "respiratory_rate",
    label: "Resp. rate",
    unit: "br/min",
    digits: 0,
    bands: [
      { tone: "emergency", side: "low", from: null, to: 8 },
      { tone: "caution", side: "high", from: 22, to: 30 },
      { tone: "emergency", side: "high", from: 30, to: null },
    ],
  },
  {
    key: "core_body_temp",
    label: "Core temp",
    unit: "°C",
    digits: 1,
    bands: [
      { tone: "emergency", side: "low", from: null, to: 35 },
      { tone: "caution", side: "high", from: 38, to: 39 },
      { tone: "emergency", side: "high", from: 39, to: null },
    ],
  },
];

export function inBand(b: Band, value: number): boolean {
  return b.side === "low"
    ? (b.from === null || value >= b.from) && (b.to === null || value < b.to)
    : (b.from === null || value > b.from) && (b.to === null || value <= b.to);
}

export function toneOf(spec: MetricSpec, value: number): Tone {
  let tone: Tone = "normal";
  for (const b of spec.bands) if (inBand(b, value) && (tone === "normal" || b.tone === "emergency")) tone = b.tone;
  return tone;
}

export function isChartedMetric(metric: string): metric is ChartedMetric {
  return METRICS.some((m) => m.key === metric);
}

// --- Radiation ------------------------------------------------------------------

/**
 * Radiation limits. The career limit is NASA-STD-3001 Vol. 1 Rev. B (2022):
 * 600 mSv effective dose over a career, for every astronaut. The dose-rate
 * levels are placeholders for a mission's own flight rules: deep-space cruise
 * background is roughly 75 µSv/h, and a solar particle event can push it far
 * higher, which is when crew shelter.
 */
export const RADIATION = {
  careerLimitMsv: 600,
  doseRateUnit: "µSv/h",
  cumulativeUnit: "mSv",
  doseRateCautionAbove: 250,
  doseRateEmergencyAbove: 2000,
  /** Share of the career limit at which the meter turns caution / emergency. */
  careerCautionShare: 0.5,
  careerEmergencyShare: 0.8,
} as const;

export function doseRateTone(microSvPerHour: number): Tone {
  return microSvPerHour > RADIATION.doseRateEmergencyAbove
    ? "emergency"
    : microSvPerHour > RADIATION.doseRateCautionAbove
      ? "caution"
      : "normal";
}

export function careerDoseTone(cumulativeMsv: number): Tone {
  const share = cumulativeMsv / RADIATION.careerLimitMsv;
  return share >= RADIATION.careerEmergencyShare ? "emergency" : share >= RADIATION.careerCautionShare ? "caution" : "normal";
}

export interface RadiationReading {
  cumulativeMsv: number | null;
  doseRate: number | null;
  /** Newest of the two samples. */
  at: string | null;
}

/** Latest cumulative dose and dose rate per crew member, from samples in any order. */
export function latestRadiation(
  samples: { crew_member_id: string; metric: string; value: number; recorded_at: string }[],
): Map<string, RadiationReading> {
  const out = new Map<string, RadiationReading & { tc: number; tr: number }>();
  for (const s of samples) {
    if (s.metric !== "cumulative_radiation_dose" && s.metric !== "radiation_dose_rate") continue;
    const t = Date.parse(s.recorded_at);
    const r = out.get(s.crew_member_id) ?? { cumulativeMsv: null, doseRate: null, at: null, tc: -Infinity, tr: -Infinity };
    if (s.metric === "cumulative_radiation_dose" && t > r.tc) {
      r.cumulativeMsv = s.value;
      r.tc = t;
    } else if (s.metric === "radiation_dose_rate" && t > r.tr) {
      r.doseRate = s.value;
      r.tr = t;
    }
    if (r.at === null || t > Date.parse(r.at)) r.at = s.recorded_at;
    out.set(s.crew_member_id, r);
  }
  return new Map([...out].map(([k, { cumulativeMsv, doseRate, at }]) => [k, { cumulativeMsv, doseRate, at }]));
}
