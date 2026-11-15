// Early-warning trend forecasts.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { FORECAST, forecast, theilSen, type Sample } from "../packages/vital-thresholds/forecast.ts";
import { METRICS } from "../packages/vital-thresholds/index.ts";

const spec = (k: string) => METRICS.find((m) => m.key === k)!;
const NOW = 1_000 * 60_000;
/** One sample per minute ending at NOW, value = f(minutesAgo). */
const series = (n: number, f: (minsAgo: number) => number): Sample[] =>
  Array.from({ length: n }, (_, i) => ({ t: NOW - (n - 1 - i) * 60_000, v: f(n - 1 - i) }));

describe("theilSen", () => {
  test("ignores a single outlier", () => {
    const s = series(10, (ago) => 100 - ago); // +1 per minute
    s[4] = { ...s[4]!, v: 500 };
    assert.ok(Math.abs(theilSen(s)!.slope * 60_000 - 1) < 1e-9);
  });
});

describe("forecast", () => {
  test("rising heart rate heading for 110 within the horizon", () => {
    // 15 samples from 89 to 103 bpm, +1/min → reaches 110 in ~7 min.
    const f = forecast(spec("heart_rate"), series(15, (ago) => 103 - ago), NOW);
    assert.ok(f);
    assert.equal(f.direction, "rising");
    assert.equal(f.threshold, 110);
    assert.ok(Math.abs(f.minutesToCross - 7) < 0.01, String(f.minutesToCross));
  });

  test("falling SpO2 heading for 94", () => {
    const f = forecast(spec("spo2"), series(15, (ago) => 96 + ago * 0.15), NOW);
    assert.ok(f);
    assert.equal(f.direction, "falling");
    assert.equal(f.threshold, 94);
    assert.ok(f.minutesToCross > 0 && f.minutesToCross <= FORECAST.horizonMin);
  });

  test("no warning when the crossing is beyond the horizon", () => {
    assert.equal(forecast(spec("heart_rate"), series(15, (ago) => 70 - ago * 0.6), NOW), null);
  });

  test("no warning for flat noise around a normal value", () => {
    assert.equal(forecast(spec("heart_rate"), series(15, (ago) => 72 + ((ago * 7) % 5) - 2), NOW), null);
  });

  test("no warning when already in a band (threshold alerts own that)", () => {
    assert.equal(forecast(spec("heart_rate"), series(15, (ago) => 125 - ago), NOW), null);
  });

  test("no warning with too few samples or too short a span", () => {
    assert.equal(forecast(spec("heart_rate"), series(FORECAST.minSamples - 1, (ago) => 103 - ago), NOW), null);
    const dense = Array.from({ length: 20 }, (_, i) => ({ t: NOW - (19 - i) * 15_000, v: 100 + i })); // 4.75 min
    assert.equal(forecast(spec("heart_rate"), dense, NOW), null);
  });

  test("a trend away from every caution edge is ignored", () => {
    assert.equal(forecast(spec("heart_rate"), series(15, (ago) => 90 + ago), NOW), null);
  });
});
