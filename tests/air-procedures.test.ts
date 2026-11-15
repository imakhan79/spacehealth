// Cabin air and procedure runs: who may write, and what is stamped.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USERS, asRole, bootSpacecraftDb, rows, seedCrew } from "./helpers/db.ts";

let db: PGlite;
let crew: { alice: string; bob: string };
const as = (user: string, sql: string, params: unknown[] = []) => asRole(db, "authenticated", sql, params, user);
const air = "insert into cabin_air (module_id, sensor_id, window_start, co2_ppm, o2_pct, humidity_pct, temp_c) values ('lab', 'lab-air1', now(), 900, 21, 45, 22)";

describe("cabin air", () => {
  before(async () => {
    db = await bootSpacecraftDb();
    crew = await seedCrew(db);
  });

  test("only the sensor gateway writes; all crew read", async () => {
    await assert.rejects(as(USERS.alice, air), /row-level security/);
    await as(USERS.gateway, air);
    assert.equal((await as(USERS.bob, "select 1 from cabin_air")).length, 1);
  });
});

describe("procedure runs", () => {
  let run: string;

  test("starter and start time are stamped as the caller, now", async () => {
    const [r] = await as(USERS.bob, "insert into procedure_runs (protocol, patient_crew_id, started_by, started_at, outcome) values ('chest_pain', $1, $1, '2000-01-01', 'completed') returning id, started_by, outcome, started_at > now() - interval '1 minute' as fresh", [crew.alice]);
    run = String(r!.id);
    assert.deepEqual([r!.started_by, r!.outcome, r!.fresh], [crew.bob, "in_progress", true]);
  });

  test("anyone aboard can record steps; done_by is the caller; a step is recorded once", async () => {
    await as(USERS.alice, "insert into procedure_steps (run_id, step_no, done_by) values ($1, 1, $2)", [run, crew.bob]);
    assert.equal((await rows(db, "select done_by from procedure_steps where run_id = $1", [run]))[0]!.done_by, crew.alice);
    await assert.rejects(as(USERS.bob, "insert into procedure_steps (run_id, step_no) values ($1, 1)", [run]), /duplicate/);
  });

  test("ending is stamped, happens once, and freezes the run", async () => {
    await as(USERS.surgeon, "update procedure_runs set outcome = 'completed', notes = 'stable' where id = $1", [run]);
    const [r] = await rows(db, "select outcome, ended_by is not null as by, ended_at is not null as at from procedure_runs where id = $1", [run]);
    assert.deepEqual(r, { outcome: "completed", by: true, at: true });
    await assert.rejects(as(USERS.bob, "update procedure_runs set notes = 'edited' where id = $1", [run]), /already ended/);
    await assert.rejects(as(USERS.bob, "insert into procedure_steps (run_id, step_no) values ($1, 2)", [run]), /run in progress/);
  });

  test("started_by can't be rewritten after the fact", async () => {
    await assert.rejects(as(USERS.bob, "update procedure_runs set started_by = $1", [crew.bob]), /permission denied/);
  });
});
