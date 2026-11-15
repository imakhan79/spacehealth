// Mission Control's uplink health summary.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { formatDuration, summarizeLink, type LinkBatch } from "../mission-control/src/lib/link-stats.ts";

const H = 3_600_000;
const batch = (atH: number, entries: number, transitS = 30, conflicts = 0): LinkBatch => ({
  batchId: `b${atH}`,
  receivedAt: atH * H,
  createdAt: atH * H - transitS * 1000,
  entries,
  bytes: entries * 100,
  conflicts,
});

describe("summarizeLink", () => {
  test("totals, median and max transit over the window only", () => {
    const s = summarizeLink([batch(-5, 999), batch(2, 10, 20), batch(4, 30, 40, 2), batch(9, 5, 600)], 0, 10 * H);
    assert.equal(s.batches, 3);
    assert.equal(s.entries, 45);
    assert.equal(s.bytes, 4500);
    assert.equal(s.conflicts, 2);
    assert.equal(s.medianTransitMs, 40_000);
    assert.equal(s.maxTransitMs, 600_000);
    assert.equal(s.lastContactAt, 9 * H);
  });

  test("longest gap is found between contacts, counting contact before the window", () => {
    const s = summarizeLink([batch(-1, 1), batch(1, 1), batch(8, 1)], 0, 9 * H);
    assert.deepEqual(s.longestGap, { from: 1 * H, to: 8 * H, ms: 7 * H, open: false });
  });

  test("an open gap up to now wins when the spacecraft has gone quiet", () => {
    const s = summarizeLink([batch(1, 1), batch(2, 1)], 0, 24 * H);
    assert.deepEqual(s.longestGap, { from: 2 * H, to: 24 * H, ms: 22 * H, open: true });
  });

  test("no batches in the window: last contact comes from before it, gap spans the window", () => {
    const s = summarizeLink([batch(-3, 1)], 0, 6 * H);
    assert.equal(s.batches, 0);
    assert.equal(s.medianTransitMs, null);
    assert.equal(s.lastContactAt, -3 * H);
    assert.deepEqual(s.longestGap, { from: 0, to: 6 * H, ms: 6 * H, open: true });
  });

  test("time before the first-ever batch is history, not a gap", () => {
    // First contact at 14h, next at 24h; window starts at 0 with nothing earlier.
    const s = summarizeLink([batch(14, 1), batch(24, 1)], 0, 25 * H);
    assert.deepEqual(s.longestGap, { from: 14 * H, to: 24 * H, ms: 10 * H, open: false });
    assert.equal(summarizeLink([], 0, 5 * H).longestGap, null);
    assert.equal(summarizeLink([], 0, 5 * H).lastContactAt, null);
  });

  test("negative transit from clock skew is clamped to zero; even count takes the mean of the middle pair", () => {
    const s = summarizeLink([batch(1, 1, -5), batch(2, 1, 10), batch(3, 1, 30), batch(4, 1, 50)], 0, 5 * H);
    assert.equal(s.maxTransitMs, 50_000);
    assert.equal(s.medianTransitMs, 20_000);
    assert.equal(summarizeLink([batch(1, 1, -5)], 0, 2 * H).medianTransitMs, 0);
  });

  test("formatDuration", () => {
    assert.equal(formatDuration(42_000), "42s");
    assert.equal(formatDuration(5 * 60_000), "5m");
    assert.equal(formatDuration(10 * H + 20 * 60_000), "10h 20m");
    assert.equal(formatDuration(50 * H), "2d 2h");
  });
});
