// Crew care rules.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { adherence, canLog, doseSlots, kitFlags, wellnessFlags } from "../src/lib/care.ts";
import { DOSE_EDGES, HATCHES, MODULES, NOISE_EDGES, binOf } from "../src/lib/habitat.ts";

const H = 3_600_000;
const DAY = Date.UTC(2026, 10, 15);

describe("medication slots", () => {
  test("taken / due / missed / upcoming relative to now", () => {
    const now = DAY + 12 * H; // 12:00Z
    const slots = doseSlots(["20:00", "08:00", "11:30", "12:30", "09:00"], [{ dueAt: DAY + 8 * H, takenAt: DAY + 8 * H + 5 * 60_000 }], now);
    assert.deepEqual(slots.map((s) => s.status), ["taken", "missed", "due", "due", "upcoming"]);
    assert.equal(canLog(slots[1]!, now), true, "missed but still within 12 h");
    assert.equal(canLog(slots[0]!, now), false, "already taken");
    assert.equal(canLog(slots[4]!, now), false, "too early");
  });
});

describe("exercise adherence", () => {
  test("rolling 7 days, capped share", () => {
    const now = DAY;
    const s = [
      { minutes: 60, performedAt: now - 1 * H },
      { minutes: 90, performedAt: now - 6 * 24 * H },
      { minutes: 500, performedAt: now - 8 * 24 * H }, // outside the window
    ];
    assert.deepEqual(adherence(s, 300, now), { minutes: 150, prescribed: 300, share: 0.5 });
    assert.equal(adherence(s, 100, now).share, 1);
    assert.equal(adherence(s, 0, now).share, null);
  });
});

describe("medical kit flags", () => {
  const now = DAY;
  test("expiry and stock", () => {
    assert.deepEqual(kitFlags({ quantity: 10, min_quantity: 2, expires_on: "2026-11-14" }, now), ["expired"]);
    assert.deepEqual(kitFlags({ quantity: 2, min_quantity: 2, expires_on: "2026-12-01" }, now), ["expiring", "low"]);
    assert.deepEqual(kitFlags({ quantity: 0, min_quantity: 2, expires_on: null }, now), ["out"]);
    assert.deepEqual(kitFlags({ quantity: 9, min_quantity: 2, expires_on: "2027-06-01" }, now), []);
  });
});

describe("wellness flags", () => {
  const now = DAY + 10 * H;
  const c = (d: string, sleep: number, fatigue = 2, mood = 4) => ({ checkin_date: d, sleep_hours: sleep, fatigue, mood });
  test("short sleep on 3 of the last 4 days, latest fatigue and mood", () => {
    const flags = wellnessFlags([c("2026-11-12", 5), c("2026-11-15", 5.5, 4, 2), c("2026-11-14", 7), c("2026-11-13", 5), c("2026-11-01", 3)], now);
    assert.deepEqual(flags, ["short_sleep", "high_fatigue", "low_mood"]);
  });
  test("no check-in today is flagged; a good recent history is not", () => {
    assert.deepEqual(wellnessFlags([c("2026-11-14", 8)], now), ["no_checkin_today"]);
    assert.deepEqual(wellnessFlags([c("2026-11-15", 8)], now), []);
  });
});


describe("habitat map", () => {
  test("sequential bins with inclusive lower edges, null for no data", () => {
    assert.equal(binOf(null, NOISE_EDGES), null);
    assert.equal(binOf(40, NOISE_EDGES), 0);
    assert.equal(binOf(45, NOISE_EDGES), 1);
    assert.equal(binOf(64.9, NOISE_EDGES), 3);
    assert.equal(binOf(68, NOISE_EDGES), 4);
    assert.equal(binOf(75, DOSE_EDGES), 1);
    assert.equal(binOf(4875, DOSE_EDGES), 4);
  });

  test("layout: unique ids, hatches join real modules, demo acoustic modules have sensors", () => {
    const ids = new Set(MODULES.map((m) => m.id));
    assert.equal(ids.size, MODULES.length);
    for (const [a, b] of HATCHES) assert.ok(ids.has(a) && ids.has(b), `${a}-${b}`);
    for (const id of ["habitat-a", "galley", "eclss-bay"]) assert.ok(MODULES.find((m) => m.id === id)?.acoustic);
  });
});
