// Trend-chart bands and tile colouring share one threshold table. These pin it
// to the original per-metric tile rules, boundaries included.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  careerDoseTone,
  doseRateTone,
  latestRadiation,
  METRICS,
  RADIATION,
  toneOf,
  type ChartedMetric,
  type Tone,
} from "../src/lib/dashboard/vital-thresholds.ts";

// The rules exactly as crew-vitals.tsx had them before the shared table.
const ORIGINAL: Record<ChartedMetric, (v: number) => Tone> = {
  heart_rate: (v) => (v > 140 || v < 40 ? "emergency" : v > 110 ? "caution" : "normal"),
  spo2: (v) => (v < 90 ? "emergency" : v < 94 ? "caution" : "normal"),
  respiratory_rate: (v) => (v > 30 || v < 8 ? "emergency" : v > 22 ? "caution" : "normal"),
  core_body_temp: (v) => (v > 39 || v < 35 ? "emergency" : v > 38 ? "caution" : "normal"),
};

describe("vital thresholds", () => {
  for (const spec of METRICS) {
    test(`${spec.key} matches the original tile rule at every 0.05 step`, () => {
      for (let i = 0; i <= 4000; i++) {
        const v = Math.round(i * 5) / 100; // 0.00 .. 200.00, exact boundaries included
        assert.equal(toneOf(spec, v), ORIGINAL[spec.key](v), `${spec.key} at ${v}`);
      }
    });
  }

  test("a value exactly on a threshold takes the milder state", () => {
    const hr = METRICS.find((m) => m.key === "heart_rate")!;
    const spo2 = METRICS.find((m) => m.key === "spo2")!;
    assert.equal(toneOf(hr, 140), "caution");
    assert.equal(toneOf(hr, 110), "normal");
    assert.equal(toneOf(hr, 40), "normal");
    assert.equal(toneOf(spo2, 90), "caution");
    assert.equal(toneOf(spo2, 94), "normal");
  });
});

describe("radiation", () => {
  test("career dose tone follows the share of the 600 mSv limit", () => {
    assert.equal(RADIATION.careerLimitMsv, 600);
    assert.equal(careerDoseTone(0), "normal");
    assert.equal(careerDoseTone(299.9), "normal");
    assert.equal(careerDoseTone(300), "caution");
    assert.equal(careerDoseTone(479.9), "caution");
    assert.equal(careerDoseTone(480), "emergency");
  });

  test("dose rate tone", () => {
    assert.equal(doseRateTone(75), "normal");
    assert.equal(doseRateTone(250), "normal");
    assert.equal(doseRateTone(251), "caution");
    assert.equal(doseRateTone(2001), "emergency");
  });

  test("latestRadiation picks the newest of each metric per member, ignoring order and other metrics", () => {
    const m = latestRadiation([
      { crew_member_id: "a", metric: "cumulative_radiation_dose", value: 10, recorded_at: "2026-01-01T00:05:00Z" },
      { crew_member_id: "a", metric: "cumulative_radiation_dose", value: 9, recorded_at: "2026-01-01T00:00:00Z" },
      { crew_member_id: "a", metric: "radiation_dose_rate", value: 70, recorded_at: "2026-01-01T00:00:00Z" },
      { crew_member_id: "a", metric: "heart_rate", value: 60, recorded_at: "2026-01-01T00:09:00Z" },
      { crew_member_id: "b", metric: "radiation_dose_rate", value: 80, recorded_at: "2026-01-01T00:01:00Z" },
    ]);
    assert.deepEqual(m.get("a"), { cumulativeMsv: 10, doseRate: 70, at: "2026-01-01T00:05:00Z" });
    assert.deepEqual(m.get("b"), { cumulativeMsv: null, doseRate: 80, at: "2026-01-01T00:01:00Z" });
    assert.equal(m.size, 2);
  });
});
