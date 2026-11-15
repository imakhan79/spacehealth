// Sleep and fatigue risk. A simple, explainable model, not a validated
// biomathematical fatigue model: each factor that raises risk is listed.

export interface SleepPeriod {
  start: number; // epoch ms
  end: number;
  quality: number | null;
}

/** Lights-off schedule (UTC hours): the planned sleep window aboard. */
export const SLEEP_WINDOW = { from: 22, to: 6 } as const;
export const SLEEP_NEED_H = 8;

const H = 3_600_000;

/** Hours slept that overlap [from, to). */
export function hoursIn(periods: SleepPeriod[], from: number, to: number): number {
  return periods.reduce((h, p) => h + Math.max(0, Math.min(p.end, to) - Math.max(p.start, from)) / H, 0);
}

export interface SleepSummary {
  last24h: number;
  avg7d: number;
  /** Shortfall against SLEEP_NEED_H over the last 7 days, hours (>= 0). */
  debt7d: number;
  hoursAwake: number | null;
}

export function summarizeSleep(periods: SleepPeriod[], now: number): SleepSummary {
  const total7 = hoursIn(periods, now - 7 * 24 * H, now);
  const lastEnd = periods.filter((p) => p.end <= now).reduce<number | null>((m, p) => (m === null || p.end > m ? p.end : m), null);
  const asleepNow = periods.some((p) => p.start <= now && p.end > now);
  return {
    last24h: hoursIn(periods, now - 24 * H, now),
    avg7d: total7 / 7,
    debt7d: Math.max(0, 7 * SLEEP_NEED_H - total7),
    hoursAwake: asleepNow ? 0 : lastEnd === null ? null : (now - lastEnd) / H,
  };
}

export type FatigueRisk = "low" | "moderate" | "high";

export interface FatigueOutlook {
  risk: FatigueRisk;
  reasons: string[];
}

/** Risk for a shift starting at `shiftStart`, from the sleep summary taken at `now`. */
export function fatigueOutlook(s: SleepSummary, shiftStart: number, now: number): FatigueOutlook {
  let points = 0;
  const reasons: string[] = [];
  if (s.last24h < 5) {
    points += 3;
    reasons.push(`Only ${s.last24h.toFixed(1)} h sleep in the last 24 h`);
  } else if (s.last24h < 6.5) {
    points += 1;
    reasons.push(`${s.last24h.toFixed(1)} h sleep in the last 24 h`);
  }
  if (s.debt7d >= 10) {
    points += 2;
    reasons.push(`Sleep debt ${s.debt7d.toFixed(0)} h this week`);
  } else if (s.debt7d >= 5) {
    points += 1;
    reasons.push(`Sleep debt ${s.debt7d.toFixed(0)} h this week`);
  }
  // Only if no lights-off window starts before the shift: otherwise they sleep first.
  const d = new Date(now);
  let lightsOff = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), SLEEP_WINDOW.from);
  if (lightsOff <= now) lightsOff += 24 * H;
  if (s.hoursAwake !== null && lightsOff >= shiftStart) {
    const awakeAtShift = s.hoursAwake + Math.max(0, shiftStart - now) / H;
    if (awakeAtShift >= 17) {
      points += 2;
      reasons.push(`Awake ${awakeAtShift.toFixed(0)} h by the shift`);
    }
  }
  const hour = new Date(shiftStart).getUTCHours();
  if (hour >= 2 && hour < 6) {
    points += 1;
    reasons.push("Shift falls in the circadian low (02–06)");
  }
  return { risk: points >= 4 ? "high" : points >= 2 ? "moderate" : "low", reasons };
}
