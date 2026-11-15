// Cabin alarm rules: what sounds, and what "silence" may and may not hide.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { alarmLevel, alarmingAlerts, shouldSound, silenceNow, SILENCE_MS } from "../src/lib/dashboard/alarm.ts";
import type { HealthAlert } from "../src/lib/dashboard/types.ts";

function alert(id: string, severity: HealthAlert["severity"], status: HealthAlert["status"], minute: number): HealthAlert {
  return { id, severity, status, triggered_at: new Date(Date.UTC(2026, 10, 15, 0, minute)).toISOString() } as HealthAlert;
}

describe("alarm", () => {
  test("only active warning and emergency alerts sound, emergency first then newest", () => {
    const list = alarmingAlerts([
      alert("w-old", "warning", "active", 1),
      alert("e", "emergency", "active", 0),
      alert("w-new", "warning", "active", 5),
      alert("c", "caution", "active", 9),
      alert("adv", "advisory", "active", 9),
      alert("ack", "emergency", "acknowledged", 9),
      alert("ovr", "warning", "overridden", 9),
    ]);
    assert.deepEqual(list.map((a) => a.id), ["e", "w-new", "w-old"]);
    assert.equal(alarmLevel(list), "emergency");
    assert.equal(alarmLevel(list.filter((a) => a.severity === "warning")), "warning");
    assert.equal(alarmLevel([]), null);
  });

  test("silence hides the current alarms until it expires", () => {
    const on = [alert("a", "warning", "active", 0)];
    const s = silenceNow(on, 1_000);
    assert.equal(shouldSound(on, null, 1_000), true);
    assert.equal(shouldSound(on, s, 1_000 + SILENCE_MS - 1), false);
    assert.equal(shouldSound(on, s, 1_000 + SILENCE_MS), true);
  });

  test("a new alarming alert sounds at once, even while silenced", () => {
    const s = silenceNow([alert("a", "warning", "active", 0)], 0);
    assert.equal(shouldSound([alert("a", "warning", "active", 0), alert("b", "emergency", "active", 1)], s, 10), true);
  });

  test("nothing sounds with no alarming alerts", () => {
    assert.equal(shouldSound([], null, 0), false);
  });
});
