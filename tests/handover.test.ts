// Shift handover summaries.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { longestGap, summarizeMember, summarizeMetric } from "../src/lib/dashboard/handover.ts";
import { METRICS } from "../packages/vital-thresholds/index.ts";

const hr = METRICS.find((m) => m.key === "heart_rate")!;
const M = 60_000;

describe("handover", () => {
  test("metric summary: min/median/max/latest and band shares", () => {
    // 60 normal, 2 caution (120, 140), 1 emergency (150), 1 low emergency (35)
    const values = [60, 70, 80, 120, 140, 150, 35, 65];
    const s = summarizeMetric(hr, values.map((v, i) => ({ t: i * M, v })));
    assert.equal(s.samples, 8);
    assert.equal(s.min, 35);
    assert.equal(s.max, 150);
    assert.equal(s.median, 75);
    assert.equal(s.latest, 65);
    assert.equal(s.cautionShare, 2 / 8);
    assert.equal(s.emergencyShare, 2 / 8);
  });

  test("an empty metric summarizes to nulls and zero shares", () => {
    const s = summarizeMetric(hr, []);
    assert.deepEqual([s.samples, s.min, s.median, s.max, s.latest, s.cautionShare], [0, null, null, null, null, 0]);
  });

  test("longest gap counts the edges of the shift", () => {
    assert.equal(longestGap([10 * M, 12 * M, 30 * M], 0, 40 * M), 18 * M);
    assert.equal(longestGap([2 * M, 3 * M], 0, 60 * M), 57 * M);
    assert.equal(longestGap([], 0, 60 * M), 60 * M);
  });

  test("member: dose added is last minus first cumulative reading in the shift", () => {
    const m = summarizeMember(
      { heart_rate: [{ t: 0, v: 70 }, { t: 60 * M, v: 72 }] },
      [{ t: -5 * M, v: 99 }, { t: 0, v: 100 }, { t: 30 * M, v: 100.05 }, { t: 60 * M, v: 100.1 }],
      0,
      60 * M,
    );
    assert.ok(Math.abs(m.doseAddedMsv! - 0.1) < 1e-9);
    assert.equal(m.doseLatestMsv, 100.1);
    assert.equal(m.longestGapMs, 60 * M);
    assert.equal(m.metrics.length, METRICS.length);
  });

  test("member: one dose reading is not enough for a delta", () => {
    assert.equal(summarizeMember({}, [{ t: 1, v: 5 }], 0, 10).doseAddedMsv, null);
  });
});
