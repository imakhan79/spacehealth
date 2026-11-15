// EVA sessions and suit telemetry: who may plan, end and write.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USERS, asRole, bootSpacecraftDb, rows, seedCrew } from "./helpers/db.ts";

const CDR = "00000000-0000-0000-0000-0000000000ce";
let db: PGlite;
let crew: { alice: string; bob: string };
let cdrId: string;
let eva: string;
const as = (user: string, sql: string, params: unknown[] = []) => asRole(db, "authenticated", sql, params, user);
const plan = "insert into eva_sessions (ev1, ev2, objective, prebreathe_start, egress_at, planned_minutes) values ($1, $2, 'Replace pump', now(), now() + interval '100 minutes', 390)";
const telemetry = "insert into suit_telemetry (session_id, crew_member_id, recorded_at, suit_pressure_kpa, co2_mmhg, o2_pct, battery_pct, feedwater_pct, scrubber_pct, heart_rate, suit_temp_c) values ($1, $2, now(), 29.6, 2, 90, 90, 90, 90, 100, 20)";

describe("EVA", () => {
  before(async () => {
    db = await bootSpacecraftDb();
    crew = await seedCrew(db);
    await db.exec(`insert into auth.users values ('${CDR}');`);
    cdrId = String((await rows(db, "insert into crew_members (auth_user_id, callsign, full_name, role) values ($1, 'CDR', 'Commander', 'commander') returning id", [CDR]))[0]!.id);
  });

  test("only the commander plans an EVA", async () => {
    await assert.rejects(as(USERS.surgeon, plan, [crew.alice, crew.bob]), /row-level security/);
    await as(CDR, plan, [crew.alice, crew.bob]);
    eva = String((await rows(db, "select id from eva_sessions"))[0]!.id);
    assert.equal((await as(USERS.alice, "select 1 from eva_sessions")).length, 1, "every crew member can see it");
  });

  test("only the sensor gateway writes suit telemetry; everyone aboard reads it", async () => {
    await assert.rejects(as(USERS.alice, telemetry, [eva, crew.alice]), /row-level security/);
    await as(USERS.gateway, telemetry, [eva, crew.alice]);
    assert.equal((await as(USERS.bob, "select 1 from suit_telemetry")).length, 1);
  });

  test("terminating is commander-only, stamped, and final", async () => {
    await as(USERS.alice, "update eva_sessions set status = 'aborted'", []);
    assert.equal((await rows(db, "select status from eva_sessions"))[0]!.status, "planned", "crew can't end it (RLS filters the row)");
    await as(CDR, "update eva_sessions set status = 'aborted', end_reason = 'Suit leak' where id = $1", [eva]);
    const [r] = await rows(db, "select status, ended_by, ended_at is not null as at from eva_sessions");
    assert.deepEqual(r, { status: "aborted", ended_by: cdrId, at: true });
    await assert.rejects(as(CDR, "update eva_sessions set status = 'eva' where id = $1", [eva]), /already ended/);
  });

  test("an EVA needs two different crew members", async () => {
    await assert.rejects(as(CDR, plan, [crew.alice, crew.alice]), /eva_two_crew/);
  });
});
