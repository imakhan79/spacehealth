// Phase 1: sync bookkeeping, coalescing and RLS on the spacecraft schema.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USERS, asRole, bootSpacecraftDb, insertTelemetry, rows, seedCrew } from "./helpers/db.ts";

let db: PGlite;
let crew: { alice: string; bob: string };

before(async () => {
  db = await bootSpacecraftDb();
  crew = await seedCrew(db);
});

describe("sync bookkeeping", () => {
  test("provisioned roster rows are queued for Earth", async () => {
    const [r] = await rows(db, "select count(*)::int n from uplink_queue where source_table = 'crew_members'");
    assert.equal(r?.n, 4);
  });

  test("ingested telemetry is queued at v1; clients cannot set sync columns", async () => {
    await insertTelemetry(db, crew.alice, 1);
    const [t] = await rows(db, "select sync_status, row_version from crew_telemetry where crew_member_id = $1", [crew.alice]);
    assert.deepEqual(t, { sync_status: "queued_for_earth", row_version: 1 });
  });

  test("hold_onboard keeps a row local_only and out of the queue", async () => {
    await asRole(
      db,
      "authenticated",
      `insert into crew_telemetry (crew_member_id, metric, value, unit, recorded_at, device_id, hold_onboard, sync_status)
       values ($1, 'spo2', 97, '%', now(), 'wrist-1', true, 'synced')`,
      [crew.alice],
      USERS.gateway,
    );
    const [held] = await rows(db, "select id, sync_status from crew_telemetry where hold_onboard");
    assert.equal(held?.sync_status, "local_only");
    const [q] = await rows(db, "select count(*)::int n from uplink_queue where source_id = $1", [held?.id]);
    assert.equal(q?.n, 0);
  });

  test("duplicate sensor samples and non-finite values are rejected", async () => {
    await assert.rejects(insertTelemetry(db, crew.alice, 1), /duplicate key/);
    await assert.rejects(
      asRole(db, "authenticated",
        `insert into crew_telemetry (crew_member_id, metric, value, unit, recorded_at, device_id) values ($1, 'spo2', 'NaN', '%', now(), 'w')`,
        [crew.alice], USERS.gateway),
      /check constraint/,
    );
  });
});

describe("RLS", () => {
  test("crew see only their own vitals; the surgeon sees all", async () => {
    await insertTelemetry(db, crew.bob, 1, 100);
    const alice = await asRole(db, "authenticated", "select crew_member_id from crew_telemetry", [], USERS.alice);
    assert.ok(alice.length > 0 && alice.every((r) => r.crew_member_id === crew.alice));
    const doc = await asRole(db, "authenticated", "select distinct crew_member_id from crew_telemetry", [], USERS.surgeon);
    assert.equal(doc.length, 2);
  });

  test("anon and crew have no access to the queue; backlog summary works", async () => {
    await assert.rejects(asRole(db, "anon", "select * from crew_telemetry"), /permission denied/);
    await assert.rejects(asRole(db, "authenticated", "select * from uplink_queue", [], USERS.alice), /permission denied/);
    const backlog = await asRole(db, "authenticated", "select * from get_uplink_backlog()", [], USERS.alice);
    assert.ok(backlog.length > 0);
  });

  test("crew cannot forge telemetry", async () => {
    await assert.rejects(
      asRole(db, "authenticated",
        `insert into crew_telemetry (crew_member_id, metric, value, unit, recorded_at, device_id) values ($1, 'spo2', 99, '%', now(), 'x')`,
        [crew.alice], USERS.alice),
      /row-level security/,
    );
  });
});

describe("health alert overrides", () => {
  let caution = "";
  let warning = "";

  before(async () => {
    await asRole(db, "authenticated",
      `insert into health_alerts (crew_member_id, metric, severity, message) values
         ($1, 'heart_rate', 'caution', 'HR elevated'), ($1, 'spo2', 'warning', 'SpO2 low')`,
      [crew.alice], USERS.gateway);
    const alerts = await rows(db, "select id, severity from health_alerts");
    caution = String(alerts.find((a) => a.severity === "caution")?.id);
    warning = String(alerts.find((a) => a.severity === "warning")?.id);
  });

  test("subject can override a CAUTION with a reason; server stamps who", async () => {
    await assert.rejects(
      asRole(db, "authenticated", "update health_alerts set status = 'overridden' where id = $1", [caution], USERS.alice),
      /override_reason is required/,
    );
    await asRole(db, "authenticated",
      "update health_alerts set status = 'overridden', override_reason = 'post-exercise' where id = $1",
      [caution], USERS.alice);
    const [a] = await rows(db, "select overridden_by, row_version, sync_status from health_alerts where id = $1", [caution]);
    assert.deepEqual(a, { overridden_by: crew.alice, row_version: 2, sync_status: "queued_for_earth" });
    const q = await rows(db, "select row_version from uplink_queue where source_id = $1", [caution]);
    assert.deepEqual(q, [{ row_version: 2 }], "pending queue entry coalesced to v2");
  });

  test("crew cannot override WARNING; immutable columns and deletes are blocked", async () => {
    await assert.rejects(
      asRole(db, "authenticated",
        "update health_alerts set status = 'overridden', override_reason = 'fine' where id = $1", [warning], USERS.alice),
      /requires flight_surgeon or commander/,
    );
    await assert.rejects(
      asRole(db, "authenticated", "update health_alerts set severity = 'advisory' where id = $1", [warning], USERS.alice),
      /permission denied/,
    );
    await assert.rejects(
      asRole(db, "authenticated", "delete from health_alerts where id = $1", [warning], USERS.alice),
      /permission denied/,
    );
  });

  test("other crew cannot touch someone else's alert", async () => {
    const updated = await asRole(db, "authenticated",
      "update health_alerts set status = 'acknowledged' where id = $1 returning id", [warning], USERS.bob);
    assert.equal(updated.length, 0);
  });
});
