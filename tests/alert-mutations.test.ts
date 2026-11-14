// Phase 4: optimistic alert dispositions and the offline outbox.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  canPerform,
  flushOne,
  overlayPending,
  type AlertMutation,
  type WriteResult,
} from "../src/lib/dashboard/alert-mutations.ts";
import type { HealthAlert, Me } from "../src/lib/dashboard/types.ts";

const alice: Me = { userId: "u-a", crewMemberId: "c-a", callsign: "ALPHA", role: "crew" };
const doc: Me = { userId: "u-d", crewMemberId: "c-d", callsign: "DOC", role: "flight_surgeon" };

function alert(over: Partial<HealthAlert> = {}): HealthAlert {
  return {
    id: "a1", crew_member_id: "c-a", telemetry_id: null, metric: "heart_rate", severity: "caution", status: "active",
    message: "HR up", triggered_at: "2026-11-15T00:00:00Z", acknowledged_by: null, acknowledged_at: null,
    overridden_by: null, overridden_at: null, override_reason: null, resolved_at: null, created_at: "2026-11-15T00:00:00Z",
    hold_onboard: false, deleted_at: null, sync_status: "queued_for_earth", last_modified_at: "2026-11-15T00:00:00Z",
    row_version: 1, earth_ack_version: 0, origin_node: "spacecraft", synced_at: null,
    ...over,
  };
}

function mutation(over: Partial<AlertMutation> = {}): AlertMutation {
  return {
    id: "m1", alertId: "a1", action: "override", reason: "exercise", baseVersion: 1,
    createdAt: "2026-11-15T00:01:00Z", attempts: 0, lastError: null, ...over,
  };
}

describe("permissions mirror the server rule", () => {
  test("crew may override their own CAUTION but not a WARNING; oversight may", () => {
    assert.deepEqual(canPerform(alert(), "override", alice), { ok: true });
    assert.equal(canPerform(alert({ severity: "warning" }), "override", alice).ok, false);
    assert.deepEqual(canPerform(alert({ severity: "emergency" }), "override", doc), { ok: true });
    assert.equal(canPerform(alert({ crew_member_id: "c-b" }), "acknowledge", alice).ok, false);
  });
});

describe("optimistic overlay", () => {
  test("pending override shows immediately and survives a server refresh", () => {
    const serverRows = [alert()];
    const [shown] = overlayPending(serverRows, [mutation()], alice);
    assert.equal(shown?.status, "overridden");
    assert.equal(shown?.override_reason, "exercise");
    assert.equal(shown?.overridden_by, "c-a");
    assert.equal(serverRows[0]?.status, "active", "server data itself is untouched");
  });
});

describe("outbox flush", () => {
  const ok = (row: HealthAlert) => async (): Promise<WriteResult> => ({ kind: "applied", row });

  test("applied -> confirmed with the server row", async () => {
    const row = alert({ status: "overridden", row_version: 2 });
    const out = await flushOne(mutation(), ok(row));
    assert.equal(out.kind, "confirmed");
  });

  test("station unreachable (fetch throws or status 0/5xx) -> kept for retry", async () => {
    const thrown = await flushOne(mutation(), async () => { throw new TypeError("Failed to fetch"); });
    assert.equal(thrown.kind, "kept");
    assert.equal(thrown.mutation.attempts, 1);
    const gateway = await flushOne(mutation(), async () => ({ kind: "error", status: 502, code: "", message: "Bad Gateway" }));
    assert.equal(gateway.kind, "kept");
    const offline = await flushOne(mutation(), async () => ({ kind: "error", status: 0, code: "", message: "TypeError: fetch failed" }));
    assert.equal(offline.kind, "kept");
  });

  test("database refusal -> rejected (UI rolls back)", async () => {
    const out = await flushOne(mutation(), async () => ({
      kind: "error", status: 403, code: "42501", message: "Overriding a warning alert requires flight_surgeon or commander",
    }));
    assert.deepEqual(out.kind, "rejected");
  });

  test("version moved on but server already shows our change (lost reply) -> confirmed", async () => {
    const out = await flushOne(mutation(), async () => ({ kind: "stale", current: alert({ status: "overridden", row_version: 2 }) }));
    assert.equal(out.kind, "confirmed");
  });

  test("version moved on to something else (e.g. resolved elsewhere) -> superseded", async () => {
    const out = await flushOne(mutation(), async () => ({ kind: "stale", current: alert({ status: "resolved", row_version: 2 }) }));
    assert.equal(out.kind, "superseded");
  });
});
