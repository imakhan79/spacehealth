// EVA suit assessment.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SUIT, assessSuit, minutesLeft, type SuitSample } from "../src/lib/eva.ts";

const M = 60_000;
/** 20 one-minute samples; fields may vary with minute i. */
const run = (over: (i: number) => Partial<SuitSample> = () => ({})): SuitSample[] =>
  Array.from({ length: 20 }, (_, i) => ({
    t: i * M,
    suit_pressure_kpa: 29.6,
    co2_mmhg: 2,
    o2_pct: 90 - i * 0.2,
    battery_pct: 95 - i * 0.2,
    feedwater_pct: 92 - i * 0.15,
    scrubber_pct: 96 - i * 0.25,
    heart_rate: 100,
    ...over(i),
  }));

describe("EVA suit assessment", () => {
  test("nominal suit: no cues; the limiting consumable is the one closest to reserve", () => {
    const a = assessSuit(run())!;
    assert.equal(a.tone, "normal");
    assert.deepEqual(a.cues, []);
    // o2: (86.2-10)/0.2=381; battery: (91.2-10)/0.2=406; feedwater: (89.15-10)/0.15=527.7; scrubber: (91.25-10)/0.25=325
    assert.equal(a.limiting!.consumable, "scrubber");
    assert.ok(Math.abs(a.limiting!.minutes - 325) < 0.01, String(a.limiting!.minutes));
  });

  test("a steady pressure fall is called a leak before the absolute limit is reached", () => {
    const a = assessSuit(run((i) => ({ suit_pressure_kpa: 29.6 - i * 0.03 })))!;
    assert.equal(a.tone, "emergency");
    assert.match(a.cues[0]!.text, /possible leak/);
  });

  test("low but steady pressure is a caution", () => {
    const a = assessSuit(run(() => ({ suit_pressure_kpa: 28.5 })))!;
    assert.deepEqual(a.cues, [{ tone: "caution", text: "Suit pressure low (28.5 kPa)" }]);
  });

  test("CO2 and heart rate cues", () => {
    assert.equal(assessSuit(run(() => ({ co2_mmhg: 9 })))!.cues[0]!.tone, "caution");
    assert.equal(assessSuit(run(() => ({ co2_mmhg: 16 })))!.tone, "emergency");
    assert.match(assessSuit(run(() => ({ heart_rate: 170 })))!.cues[0]!.text, /high workload/);
  });

  test("return and terminate cues from consumable time left", () => {
    const close = assessSuit(run((i) => ({ battery_pct: 20 - i * 0.5 })))!; // (10.5-10)/0.5 = 1 min
    assert.equal(close.limiting!.consumable, "battery");
    assert.equal(close.tone, "emergency");
    const soon = assessSuit(run((i) => ({ battery_pct: 30 - i * 0.5 })))!; // (20.5-10)/0.5 = 21 min
    assert.match(soon.cues.at(-1)!.text, /return to airlock within 21 min/);
  });

  test("a consumable that isn't draining has no time limit", () => {
    assert.equal(minutesLeft(run(() => ({ feedwater_pct: 80 })), "feedwater"), null);
    assert.equal(SUIT.reservePct, 10);
  });
});
