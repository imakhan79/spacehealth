// ECG rhythm, sleep and fatigue, nutrition and supplies rules.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { analyzeRhythm, beatsBetween, ecgValue } from "../src/lib/ecg.ts";
import { TARGETS, behind, totals } from "../src/lib/nutrition.ts";
import { fatigueOutlook, hoursIn, summarizeSleep } from "../src/lib/sleep.ts";
import { MARGIN_DAYS, RESUPPLY_IN_DAYS, supplyStatus, usagePerDay } from "../src/lib/supplies.ts";

const H = 3_600_000;
const D = 24 * H;

describe("ECG", () => {
  const times = (hr: number, pvc = 0) => beatsBetween(hr, 0, 60, pvc).map((b) => b.t);

  test("beats are deterministic and match the rate", () => {
    assert.deepEqual(beatsBetween(72, 10, 20), beatsBetween(72, 10, 20));
    const b = beatsBetween(60, 0, 60);
    assert.ok(b.length >= 58 && b.length <= 62, String(b.length));
  });

  test("rhythm labels by rate", () => {
    assert.equal(analyzeRhythm(times(70))!.label, "Sinus rhythm");
    assert.equal(analyzeRhythm(times(70))!.tone, "normal");
    assert.equal(analyzeRhythm(times(118))!.label, "Sinus tachycardia");
    assert.equal(analyzeRhythm(times(44))!.label, "Sinus bradycardia");
  });

  test("premature beats are detected and counted", () => {
    const r = analyzeRhythm(times(80, 10))!;
    assert.equal(r.label, "Sinus rhythm with premature beats");
    assert.ok(r.prematurePerMin > 5 && r.prematurePerMin < 11, String(r.prematurePerMin));
    assert.equal(r.tone, "caution");
    assert.equal(r.irregular, false, "PVCs with compensatory pauses aren't an irregular underlying rhythm");
  });

  test("an irregularly irregular series is flagged", () => {
    const t = [0];
    for (let i = 1; i < 40; i++) t.push(t[i - 1]! + [0.5, 0.95, 0.62, 1.1, 0.7, 0.85][i % 6]!);
    assert.equal(analyzeRhythm(t)!.irregular, true);
  });

  test("too few beats: no call", () => assert.equal(analyzeRhythm([0, 1, 2]), null));

  test("the R peak dominates the waveform", () => {
    const b = [{ t: 1, kind: "normal" as const }];
    assert.ok(ecgValue(1, b) > 0.9);
    assert.ok(Math.abs(ecgValue(1.5, b)) < 0.35);
  });
});

describe("sleep", () => {
  const now = Date.UTC(2026, 10, 15, 10);
  const night = (daysAgo: number, hours: number) => ({ start: now - daysAgo * D - 4 * H - hours * H, end: now - daysAgo * D - 4 * H, quality: 3 });

  test("hours overlapping a window", () => {
    assert.equal(hoursIn([{ start: 0, end: 10 * H, quality: null }], 5 * H, 20 * H), 5);
  });

  test("summary: last 24 h, 7-day average, debt and hours awake", () => {
    const s = summarizeSleep([0, 1, 2, 3, 4, 5, 6].map((d) => night(d, 6)), now);
    assert.equal(s.last24h, 6);
    assert.equal(s.avg7d, 6);
    assert.equal(s.debt7d, 14);
    assert.equal(s.hoursAwake, 4);
  });

  test("fatigue: short sleep plus debt is high; a rested crew member is low", () => {
    const tired = summarizeSleep([0, 1, 2, 3, 4, 5, 6].map((d) => night(d, 4.5)), now);
    assert.equal(fatigueOutlook(tired, now, now).risk, "high");
    const rested = summarizeSleep([0, 1, 2, 3, 4, 5, 6].map((d) => night(d, 8)), now);
    assert.deepEqual(fatigueOutlook(rested, now, now), { risk: "low", reasons: [] });
  });

  test("hours awake count to the shift, unless a sleep window comes first", () => {
    // Last sleep ended 01:00; it is 15:00 (awake 14 h).
    const at15 = Date.UTC(2026, 10, 15, 15);
    const s = summarizeSleep([{ start: Date.UTC(2026, 10, 14, 17), end: Date.UTC(2026, 10, 15, 1), quality: 3 }], at15);
    assert.equal(s.hoursAwake, 14);
    // Shift at 20:00 the same evening: awake 19 h by then, flagged.
    assert.ok(fatigueOutlook(s, Date.UTC(2026, 10, 15, 20), at15).reasons.some((x) => x.includes("Awake 19 h")));
    // Shift at 08:00 next morning: lights-off at 22:00 comes first, so not flagged.
    assert.ok(!fatigueOutlook(s, Date.UTC(2026, 10, 16, 8), at15).reasons.some((x) => x.startsWith("Awake")));
  });

  test("a shift in the circadian low adds risk, with the reason", () => {
    const rested = summarizeSleep([0, 1, 2, 3, 4, 5, 6].map((d) => night(d, 8)), now);
    const r = fatigueOutlook(rested, Date.UTC(2026, 10, 16, 3), now);
    assert.ok(r.reasons.some((x) => x.includes("circadian low")));
  });
});

describe("nutrition", () => {
  test("totals add up and missing fields count as zero", () => {
    assert.deepEqual(totals([{ kcal: 100, water_ml: 250 }, { kcal: 50, protein_g: 5 }]), { kcal: 150, protein_g: 5, calcium_mg: 0, vitamin_d_iu: 0, water_ml: 250 });
  });

  test("behind-pace flags: none before 11:00; by evening a low day is flagged", () => {
    const low = totals([{ kcal: 500, water_ml: 500, protein_g: 20, calcium_mg: 100 }]);
    assert.deepEqual(behind(low, 9), []);
    assert.deepEqual(behind(low, 20), ["kcal", "protein_g", "calcium_mg", "vitamin_d_iu", "water_ml"]);
    assert.deepEqual(behind(TARGETS, 20), []);
  });
});

describe("supplies", () => {
  const now = 100 * D;
  const series = (start: number, perDay: number) => Array.from({ length: 8 }, (_, i) => ({ t: now - (7 - i) * D, q: start - i * perDay }));

  test("least-squares usage per day", () => {
    assert.ok(Math.abs(usagePerDay(series(100, 2))! - 2) < 1e-9);
    assert.equal(usagePerDay([{ t: 0, q: 1 }]), null);
  });

  test("plenty: normal; short of resupply + margin: caution; short of resupply: emergency", () => {
    assert.equal(supplyStatus(series(1000, 1), now)!.tone, "normal");
    const margin = RESUPPLY_IN_DAYS + MARGIN_DAYS / 2;
    assert.equal(supplyStatus(series(margin + 7, 1), now)!.tone, "caution");
    const s = supplyStatus(series(45, 1), now)!;
    assert.equal(s.tone, "emergency");
    assert.equal(s.daysLeft, 38);
    assert.match(s.advice, /ration now/);
  });

  test("not being consumed: no depletion date", () => {
    assert.equal(supplyStatus(series(50, 0), now)!.daysLeft, null);
  });
});
