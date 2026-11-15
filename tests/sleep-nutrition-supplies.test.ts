// Sleep, intake and supplies tables: ownership, gateway rights, guard rails.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USERS, asRole, bootSpacecraftDb, rows, seedCrew } from "./helpers/db.ts";

let db: PGlite;
let crew: { alice: string; bob: string };
const as = (user: string, sql: string, params: unknown[] = []) => asRole(db, "authenticated", sql, params, user);
const sleepSql = "insert into sleep_periods (crew_member_id, started_at, ended_at, source) values ($1, now() - interval '9 hours', now() - interval '1 hour', 'wearable') returning crew_member_id, source";

describe("sleep, intake, supplies", () => {
  before(async () => {
    db = await bootSpacecraftDb();
    crew = await seedCrew(db);
  });

  test("crew log their own sleep (stamped manual); the gateway records for anyone", async () => {
    const [mine] = await as(USERS.alice, sleepSql, [crew.bob]);
    assert.deepEqual(mine, { crew_member_id: crew.alice, source: "manual" });
    // The gateway writes for anyone but can't read health data back (no RETURNING).
    await as(USERS.gateway, sleepSql.replace(" returning crew_member_id, source", ""), [crew.bob]);
    const [gw] = await rows(db, "select crew_member_id, source from sleep_periods where crew_member_id = $1", [crew.bob]);
    assert.deepEqual(gw, { crew_member_id: crew.bob, source: "wearable" });
    assert.equal((await as(USERS.gateway, "select 1 from sleep_periods")).length, 0);
  });

  test("sleep outside the last 48 h, or reversed, is refused", async () => {
    await assert.rejects(as(USERS.alice, "insert into sleep_periods (started_at, ended_at) values (now() - interval '3 days', now() - interval '70 hours')"), /last 48 hours/);
    await assert.rejects(as(USERS.alice, "insert into sleep_periods (started_at, ended_at) values (now() - interval '1 hour', now() - interval '2 hours')"), /sleep_periods_order/);
  });

  test("sleep is private to the member and oversight", async () => {
    assert.equal((await as(USERS.bob, "select 1 from sleep_periods")).length, 1); // only the gateway's record for bob
    assert.equal((await as(USERS.surgeon, "select 1 from sleep_periods")).length, 2);
  });

  test("intake is stamped as the caller; future times are clamped to now", async () => {
    await as(USERS.alice, "insert into intake_logs (crew_member_id, kind, label, water_ml, logged_at) values ($1, 'water', 'Water', 250, now() + interval '5 hours')", [crew.bob]);
    const [r] = await rows(db, "select crew_member_id, logged_at <= now() as past from intake_logs");
    assert.deepEqual(r, { crew_member_id: crew.alice, past: true });
    assert.equal((await as(USERS.bob, "select 1 from intake_logs")).length, 0);
  });

  test("supplies: gateway and commander record; others read only; recorder stamped", async () => {
    await assert.rejects(as(USERS.alice, "insert into consumable_readings (resource, quantity) values ('water', 100)"), /row-level security/);
    await as(USERS.gateway, "insert into consumable_readings (resource, quantity) values ('water', 1850)");
    const [r] = await as(USERS.alice, "select quantity, recorded_by from consumable_readings");
    assert.equal(r!.quantity, 1850);
    assert.ok(r!.recorded_by);
  });
});
