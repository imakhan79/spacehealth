// Crew care tables: ownership, oversight, stamping and guard rails, on the
// real migrations in PGlite.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USERS, asRole, bootSpacecraftDb, rows, seedCrew } from "./helpers/db.ts";

let db: PGlite;
let crew: { alice: string; bob: string };
const as = (user: string, sql: string, params: unknown[] = []) => asRole(db, "authenticated", sql, params, user);

describe("crew care", () => {
  before(async () => {
    db = await bootSpacecraftDb();
    crew = await seedCrew(db);
  });

  test("wellness: stamped as the caller for today; others' check-ins are private", async () => {
    await as(USERS.alice, "insert into wellness_checkins (crew_member_id, checkin_date, sleep_hours, fatigue, mood) values ($1, '2000-01-01', 6.5, 3, 4)", [crew.bob]);
    const r = await rows(db, "select crew_member_id, checkin_date = (now() at time zone 'utc')::date as today from wellness_checkins");
    assert.deepEqual(r, [{ crew_member_id: crew.alice, today: true }]);
    assert.equal((await as(USERS.bob, "select 1 from wellness_checkins")).length, 0);
    assert.equal((await as(USERS.surgeon, "select 1 from wellness_checkins")).length, 1);
  });

  test("wellness: one per day, revisable today via upsert", async () => {
    await as(USERS.alice, "insert into wellness_checkins (sleep_hours, fatigue, mood) values (7, 2, 4) on conflict (crew_member_id, checkin_date) do update set sleep_hours = excluded.sleep_hours");
    assert.equal(Number((await rows(db, "select sleep_hours from wellness_checkins"))[0]!.sleep_hours), 7);
    await assert.rejects(as(USERS.alice, "insert into wellness_checkins (sleep_hours, fatigue, mood, symptoms) values (7, 2, 4, '{made_up}')"), /check constraint|duplicate/);
  });

  test("medications: only oversight prescribes; doses only for your own, due now", async () => {
    await assert.rejects(as(USERS.alice, "insert into medications (crew_member_id, name, dose, schedule_utc) values ($1, 'x', '1', '{08:00}')", [crew.alice]), /row-level security/);
    const [med] = await as(USERS.surgeon, "insert into medications (crew_member_id, name, dose, schedule_utc) values ($1, 'Vitamin D', '1000 IU', '{08:00}') returning id, prescribed_by", [crew.alice]);
    assert.ok(med!.prescribed_by);
    // Same scheduled slot twice: the second is refused.
    const slot = new Date(Date.now() - 10 * 60_000).toISOString();
    await as(USERS.alice, "insert into medication_doses (medication_id, due_at) values ($1, $2)", [med!.id, slot]);
    await assert.rejects(as(USERS.alice, "insert into medication_doses (medication_id, due_at) values ($1, $2)", [med!.id, slot]), /duplicate/);
    await assert.rejects(as(USERS.bob, "insert into medication_doses (medication_id, due_at) values ($1, now() - interval '1 minute')", [med!.id]), /Not one of your active medications/);
    await assert.rejects(as(USERS.alice, "insert into medication_doses (medication_id, due_at) values ($1, now() - interval '2 days')", [med!.id]), /not due now/);
  });

  test("medical kit: atomic use, never below zero, stamped", async () => {
    const [item] = await rows(db, "insert into medical_inventory (item, category, quantity, unit, location) values ('Ibuprofen 200 mg', 'medication', 2, 'tablets', 'Kit A') returning id");
    assert.equal((await as(USERS.bob, "select use_medical_item($1, 1) as q", [item!.id]))[0]!.q, 1);
    assert.equal((await as(USERS.bob, "select use_medical_item($1, 5) as q", [item!.id]))[0]!.q, null);
    const r = await rows(db, "select quantity, updated_by from medical_inventory where id = $1", [item!.id]);
    assert.deepEqual(r[0], { quantity: 1, updated_by: crew.bob });
    await assert.rejects(as(USERS.bob, "update medical_inventory set item = 'renamed'"), /permission denied/);
  });

  test("exercise: logged as yourself, never in the future", async () => {
    await as(USERS.bob, "insert into exercise_sessions (crew_member_id, kind, minutes, performed_at) values ($1, 'treadmill', 30, now() + interval '3 hours')", [crew.alice]);
    const r = await rows(db, "select crew_member_id, performed_at <= now() as past from exercise_sessions");
    assert.deepEqual(r, [{ crew_member_id: crew.bob, past: true }]);
  });

  test("locations: everyone sees everyone; you only move yourself", async () => {
    await as(USERS.alice, "insert into crew_locations (module_id) values ('lab') on conflict (crew_member_id) do update set module_id = excluded.module_id");
    await as(USERS.alice, "insert into crew_locations (module_id) values ('galley') on conflict (crew_member_id) do update set module_id = excluded.module_id");
    assert.deepEqual(await as(USERS.bob, "select module_id from crew_locations"), [{ module_id: "galley" }]);
    await as(USERS.bob, "update crew_locations set module_id = 'airlock'");
    assert.equal((await rows(db, "select module_id from crew_locations"))[0]!.module_id, "galley");
  });
});
