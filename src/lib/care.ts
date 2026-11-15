// Crew care rules: medication slots, exercise adherence, medical kit flags and
// wellness flags. Pure and tested; the pages only render what these decide.

const H = 3_600_000;

// --- medications -----------------------------------------------------------------

export type SlotStatus = "taken" | "due" | "upcoming" | "missed";

export interface DoseSlot {
  dueAt: number;
  status: SlotStatus;
  takenAt: number | null;
}

/** A dose can be logged from 12 h before now up to 1 h ahead (matches the DB trigger). */
export const DOSE_EARLY_MS = 1 * H;
export const DOSE_LATE_MS = 12 * H;
/** Past this, an untaken dose counts as missed (still loggable until 12 h). */
export const DOSE_MISSED_AFTER_MS = 2 * H;

/** Today's (UTC) scheduled slots for one medication, with their status. */
export function doseSlots(scheduleUtc: string[], taken: { dueAt: number; takenAt: number }[], now: number): DoseSlot[] {
  const day = new Date(now);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const takenBySlot = new Map(taken.map((d) => [d.dueAt, d.takenAt]));
  return scheduleUtc
    .map((hhmm) => {
      const [h = 0, m = 0] = hhmm.split(":").map(Number);
      return midnight + h * H + m * 60_000;
    })
    .sort((a, b) => a - b)
    .map((dueAt) => {
      const takenAt = takenBySlot.get(dueAt) ?? null;
      const status: SlotStatus =
        takenAt !== null ? "taken"
        : dueAt > now + DOSE_EARLY_MS ? "upcoming"
        : now - dueAt > DOSE_MISSED_AFTER_MS ? "missed"
        : "due";
      return { dueAt, status, takenAt };
    });
}

/** Missed slots can still be logged (late) until the DB window closes. */
export function canLog(slot: DoseSlot, now: number): boolean {
  return slot.status !== "taken" && slot.dueAt <= now + DOSE_EARLY_MS && slot.dueAt >= now - DOSE_LATE_MS;
}

// --- exercise --------------------------------------------------------------------

export interface Adherence {
  minutes: number;
  prescribed: number;
  /** minutes / prescribed, capped at 1 for display; null if nothing prescribed. */
  share: number | null;
}

/** Rolling 7-day minutes against the weekly prescription. */
export function adherence(sessions: { minutes: number; performedAt: number }[], weeklyMinutes: number, now: number): Adherence {
  const minutes = sessions.filter((s) => s.performedAt > now - 7 * 24 * H && s.performedAt <= now).reduce((n, s) => n + s.minutes, 0);
  return { minutes, prescribed: weeklyMinutes, share: weeklyMinutes > 0 ? Math.min(1, minutes / weeklyMinutes) : null };
}

// --- medical kit -----------------------------------------------------------------

export type KitFlag = "expired" | "expiring" | "out" | "low";

export function kitFlags(item: { quantity: number; min_quantity: number; expires_on: string | null }, now: number): KitFlag[] {
  const flags: KitFlag[] = [];
  if (item.expires_on) {
    const end = Date.parse(`${item.expires_on}T23:59:59Z`);
    if (end < now) flags.push("expired");
    else if (end < now + 30 * 24 * H) flags.push("expiring");
  }
  if (item.quantity === 0) flags.push("out");
  else if (item.quantity <= item.min_quantity) flags.push("low");
  return flags;
}

// --- wellness --------------------------------------------------------------------

export interface Checkin {
  checkin_date: string; // YYYY-MM-DD
  sleep_hours: number;
  fatigue: number;
  mood: number;
}

export type WellnessFlag = "no_checkin_today" | "short_sleep" | "high_fatigue" | "low_mood";

/** Flags a flight surgeon should see for one crew member. Check-ins in any order. */
export function wellnessFlags(checkins: Checkin[], now: number): WellnessFlag[] {
  const today = new Date(now).toISOString().slice(0, 10);
  const recent = [...checkins].sort((a, b) => b.checkin_date.localeCompare(a.checkin_date)).slice(0, 4);
  const flags: WellnessFlag[] = [];
  if (!recent.some((c) => c.checkin_date === today)) flags.push("no_checkin_today");
  if (recent.filter((c) => c.sleep_hours < 6).length >= 3) flags.push("short_sleep");
  const latest = recent[0];
  if (latest && latest.fatigue >= 4) flags.push("high_fatigue");
  if (latest && latest.mood <= 2) flags.push("low_mood");
  return flags;
}

export const WELLNESS_FLAG_TEXT: Record<WellnessFlag, string> = {
  no_checkin_today: "No check-in today",
  short_sleep: "Under 6 h sleep on 3 of the last 4 days",
  high_fatigue: "High fatigue",
  low_mood: "Low mood",
};
