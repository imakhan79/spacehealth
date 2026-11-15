// Readiness, cabin air, procedures and timeline rules.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { assessAir } from "../src/lib/air.ts";
import { PROTOCOLS, missingCritical } from "../src/lib/procedures.ts";
import { readiness } from "../src/lib/readiness.ts";
import { buildTimeline, filterTimeline, type EventKind } from "../src/lib/timeline.ts";

describe("readiness", () => {
  const base = { checkin: { sleep_hours: 8, fatigue: 2, mood: 4, symptoms: ["none"] }, vitalsTone: "normal" as const, openAlert: null, exerciseShare: 1, missedDosesToday: 0 };
  test("a good day is 100 and ready", () => {
    assert.deepEqual(readiness(base), { score: 100, band: "ready", deductions: [], incomplete: false });
  });
  test("deductions add up, are listed largest first, and set the band", () => {
    const r = readiness({ ...base, checkin: { sleep_hours: 5.5, fatigue: 4, mood: 3, symptoms: ["insomnia"] }, vitalsTone: "caution", missedDosesToday: 1 });
    assert.equal(r.score, 100 - 15 - 12 - 4 - 10 - 5); // 54
    assert.equal(r.band, "review");
    assert.equal(readiness({ ...base, checkin: { sleep_hours: 6.5, fatigue: 3, mood: 4, symptoms: ["headache"] }, vitalsTone: "caution" }).band, "monitor"); // 100-5-5-4-10 = 76
    assert.deepEqual(r.deductions.map((d) => d.points), [15, 12, 10, 5, 4]);
  });
  test("emergency vitals and alert put a member into medical review; floor is 0", () => {
    const r = readiness({ ...base, checkin: { sleep_hours: 3, fatigue: 5, mood: 1, symptoms: ["a", "b", "c", "d"] }, vitalsTone: "emergency", openAlert: "emergency", exerciseShare: 0.1, missedDosesToday: 4 });
    assert.equal(r.score, 0);
    assert.equal(r.band, "review");
  });
  test("no check-in: scored on what is known, marked incomplete", () => {
    const r = readiness({ ...base, checkin: null });
    assert.equal(r.score, 100);
    assert.equal(r.incomplete, true);
  });
});

describe("cabin air", () => {
  const ok = { co2_ppm: 900, o2_pct: 21, humidity_pct: 45, temp_c: 22 };
  test("normal air has no issues", () => assert.deepEqual(assessAir(ok), { tone: "normal", issues: [] }));
  test("CO2 caution and emergency; worst tone wins", () => {
    assert.equal(assessAir({ ...ok, co2_ppm: 2900 }).tone, "caution");
    const r = assessAir({ ...ok, co2_ppm: 6000, humidity_pct: 15 });
    assert.equal(r.tone, "emergency");
    assert.equal(r.issues.length, 2);
  });
  test("O2 ranges", () => {
    assert.equal(assessAir({ ...ok, o2_pct: 19 }).tone, "caution");
    assert.equal(assessAir({ ...ok, o2_pct: 16 }).tone, "emergency");
  });
});

describe("procedures", () => {
  test("every protocol has unique id, steps, and at least one critical step", () => {
    assert.equal(new Set(PROTOCOLS.map((p) => p.id)).size, PROTOCOLS.length);
    for (const p of PROTOCOLS) {
      assert.match(p.id, /^[a-z0-9_]{1,40}$/, "matches the DB check");
      assert.ok(p.steps.some((s) => s.critical), p.id);
    }
  });
  test("missing critical steps, by 1-based number", () => {
    const chest = PROTOCOLS.find((p) => p.id === "chest_pain")!;
    assert.deepEqual(missingCritical(chest, [1, 3]), [2, 6]);
    assert.deepEqual(missingCritical(chest, [1, 2, 3, 6]), []);
  });
});

describe("timeline", () => {
  const sources = {
    alerts: [
      { id: "a1", crew_member_id: "ms1", severity: "warning" as const, status: "acknowledged", message: "HR high", triggered_at: "2026-11-15T08:00:00Z", acknowledged_by: "cdr", acknowledged_at: "2026-11-15T08:05:00Z", overridden_by: null, overridden_at: null, override_reason: null, resolved_at: null },
    ],
    doses: [{ id: "d1", crew_member_id: "ms1", medication_id: "m1", due_at: "2026-11-15T04:00:00Z", taken_at: "2026-11-15T07:00:00Z" }],
    medNames: new Map([["m1", "Omega-3"]]),
    sessions: [{ id: "s1", crew_member_id: "cdr", kind: "treadmill", minutes: 30, performed_at: "2026-11-15T06:00:00Z" }],
    checkins: [{ id: "c1", crew_member_id: "cmo", sleep_hours: 5, fatigue: 3, mood: 3, updated_at: "2026-11-15T07:30:00Z" }],
    messages: [{ id: "g1", author: "Flight Surgeon", subject: "Hello", priority: "routine", recipient_crew_id: null, received_at: "2026-11-15T05:00:00Z" }],
    runs: [{ id: "r1", protocol: "burn", patient_crew_id: "cmo", started_by: "cdr", started_at: "2026-11-15T09:00:00Z", outcome: "completed", ended_at: "2026-11-15T09:20:00Z", ended_by: "cdr" }],
    protocolTitle: (id: string) => (id === "burn" ? "Burn" : id),
  };
  const all = buildTimeline(sources);
  const kinds = new Set<EventKind>(["alert", "dose", "exercise", "checkin", "message", "procedure"]);
  const label = (e: (typeof all)[number]) => `${e.title} ${e.detail ?? ""}`;

  test("every source becomes events, newest first, with derived ones", () => {
    assert.deepEqual(all.map((e) => e.id), ["p:r1:end", "p:r1", "a:a1:ack", "a:a1", "c:c1", "d:d1", "e:s1", "m:g1"]);
    assert.equal(all.find((e) => e.id === "d:d1")!.title, "Took Omega-3 (late)");
    assert.equal(all.find((e) => e.id === "c:c1")!.tone, "caution");
  });

  test("crew filter matches subject or actor; all-crew messages always match", () => {
    const cdr = filterTimeline(all, { crewId: "cdr", kinds, query: "" }, label).map((e) => e.id);
    assert.deepEqual(cdr, ["p:r1:end", "p:r1", "a:a1:ack", "e:s1", "m:g1"]);
  });

  test("kind and text filters", () => {
    assert.deepEqual(filterTimeline(all, { crewId: null, kinds: new Set(["dose"]), query: "" }, label).map((e) => e.id), ["d:d1"]);
    assert.deepEqual(filterTimeline(all, { crewId: null, kinds, query: "hr high" }, label).map((e) => e.id), ["a:a1:ack", "a:a1"]);
  });
});
