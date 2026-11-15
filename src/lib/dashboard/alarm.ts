// Which alerts sound the cabin alarm, and how "silence" works. Pure, so the
// rules are testable without a browser.
import type { HealthAlert } from "./types";

export type AlarmLevel = "emergency" | "warning";

/** Active warning/emergency alerts, emergency first, then newest first. */
export function alarmingAlerts(alerts: HealthAlert[]): HealthAlert[] {
  return alerts
    .filter((a) => a.status === "active" && (a.severity === "emergency" || a.severity === "warning"))
    .sort((a, b) => (a.severity === b.severity ? b.triggered_at.localeCompare(a.triggered_at) : a.severity === "emergency" ? -1 : 1));
}

export function alarmLevel(alarming: HealthAlert[]): AlarmLevel | null {
  if (alarming.some((a) => a.severity === "emergency")) return "emergency";
  return alarming.length > 0 ? "warning" : null;
}

/**
 * A silence covers the alerts that were sounding when it was pressed, for a
 * limited time. A new alarming alert is never covered: it sounds at once.
 * There is deliberately no permanent mute.
 */
export interface Silence {
  until: number;
  alertIds: string[];
}

export const SILENCE_MS = 5 * 60_000;

export function silenceNow(alarming: HealthAlert[], now: number): Silence {
  return { until: now + SILENCE_MS, alertIds: alarming.map((a) => a.id) };
}

export function shouldSound(alarming: HealthAlert[], silence: Silence | null, now: number): boolean {
  if (alarming.length === 0) return false;
  if (silence === null || now >= silence.until) return true;
  const covered = new Set(silence.alertIds);
  return alarming.some((a) => !covered.has(a.id));
}
