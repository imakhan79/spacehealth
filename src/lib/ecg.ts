// ECG for the crew monitor. The demo has no real ECG electrodes, so the trace
// is *synthesized* from each member's heart-rate telemetry (and labelled as
// such). The rhythm analysis works on beat times, the way a monitor reads R
// peaks, so it would work unchanged on real detected beats.

export type BeatKind = "normal" | "premature";

export interface Beat {
  t: number; // seconds
  kind: BeatKind;
}

/**
 * Beat times in [from, to) for a heart rate, with mild respiratory variation.
 * If pvcEvery > 0, every nth beat comes early (65% of the RR interval) and is
 * followed by a compensatory pause, like a premature ventricular contraction.
 * Deterministic: the same inputs give the same beats.
 */
export function beatsBetween(hr: number, from: number, to: number, pvcEvery = 0): Beat[] {
  const rr = 60 / Math.max(20, Math.min(250, hr));
  const out: Beat[] = [];
  // Walk from a fixed origin so scrolling windows agree with each other.
  let n = Math.floor(from / rr) - 2;
  let t = n * rr;
  while (t < to) {
    const variation = 1 + 0.03 * Math.sin(n / 3.7);
    const premature = pvcEvery > 0 && n % pvcEvery === 0;
    const beatAt = premature ? t - rr * 0.35 : t;
    if (beatAt >= from) out.push({ t: beatAt, kind: premature ? "premature" : "normal" });
    t += rr * variation;
    n++;
  }
  return out.filter((b) => b.t < to).sort((a, b) => a.t - b.t);
}

const g = (x: number, mu: number, sigma: number, amp: number) => amp * Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));

/** Millivolts at time t given the nearby beats: P, QRS, T as Gaussians. */
export function ecgValue(t: number, beats: Beat[]): number {
  let v = 0;
  for (const b of beats) {
    const x = t - b.t;
    if (x < -0.3 || x > 0.6) continue;
    if (b.kind === "normal") {
      v += g(x, -0.16, 0.025, 0.12); // P
      v += g(x, -0.025, 0.01, -0.12); // Q
      v += g(x, 0, 0.012, 1.1); // R
      v += g(x, 0.03, 0.012, -0.25); // S
      v += g(x, 0.26, 0.05, 0.3); // T
    } else {
      // Wide, tall ventricular complex with no P wave and an inverted T.
      v += g(x, 0, 0.035, 1.35);
      v += g(x, 0.07, 0.03, -0.45);
      v += g(x, 0.3, 0.06, -0.3);
    }
  }
  return v;
}

export interface Rhythm {
  rate: number;
  label: string;
  /** Premature beats per minute in the analysed window. */
  prematurePerMin: number;
  irregular: boolean;
  tone: "normal" | "caution";
}

/** Classifies a rhythm from beat times (seconds, ascending), at least ~8 beats. */
export function analyzeRhythm(times: number[]): Rhythm | null {
  if (times.length < 8) return null;
  const rr = times.slice(1).map((t, i) => t - times[i]!);
  const sorted = [...rr].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1]!;
  // Premature: a short interval followed by a long (compensatory) one.
  let premature = 0;
  const regular: number[] = [];
  for (let i = 0; i < rr.length; i++) {
    if (rr[i]! < 0.8 * median && (rr[i + 1] ?? 0) > 1.2 * median) {
      premature++;
      i++; // skip the compensatory pause
    } else regular.push(rr[i]!);
  }
  const mean = regular.reduce((a, b) => a + b, 0) / regular.length;
  const sd = Math.sqrt(regular.reduce((a, b) => a + (b - mean) ** 2, 0) / regular.length);
  const irregular = sd / mean > 0.15;
  const rate = Math.round(60 / median);
  const minutes = (times.at(-1)! - times[0]!) / 60;
  const base = irregular ? "Irregular rhythm" : rate > 100 ? "Sinus tachycardia" : rate < 50 ? "Sinus bradycardia" : "Sinus rhythm";
  const prematurePerMin = minutes > 0 ? premature / minutes : 0;
  return {
    rate,
    label: premature > 0 ? `${base} with premature beats` : base,
    prematurePerMin,
    irregular,
    tone: irregular || premature > 0 || rate > 100 || rate < 50 ? "caution" : "normal",
  };
}
