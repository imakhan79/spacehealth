// Crew inbox: who can see which message from Mission Control, and how reads
// are stamped. Runs the real migrations in PGlite.
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { USERS, asRole, bootSpacecraftDb, rows, seedCrew } from "./helpers/db.ts";

let db: PGlite;
let crew: { alice: string; bob: string };
let toAll: string;
let toBob: string;

async function visibleTo(user: string): Promise<string[]> {
  return (await asRole(db, "authenticated", "select subject from ground_messages order by subject", [], user)).map((r) => String(r.subject));
}

describe("ground messages", () => {
  before(async () => {
    db = await bootSpacecraftDb();
    crew = await seedCrew(db);
    const ins = (subject: string, recipient: string | null) =>
      asRole(db, "omni_relay",
        "insert into ground_messages (author, subject, body, sent_at, recipient_crew_id) values ('Flight Surgeon', $1, 'b', now(), $2) returning id",
        [subject, recipient]);
    toAll = String((await ins("all-crew", null))[0]!.id);
    toBob = String((await ins("for-bravo", crew.bob))[0]!.id);
  });

  test("crew see all-crew messages and their own, not other members'", async () => {
    assert.deepEqual(await visibleTo(USERS.alice), ["all-crew"]);
    assert.deepEqual(await visibleTo(USERS.bob), ["all-crew", "for-bravo"]);
  });

  test("medical oversight sees every message", async () => {
    assert.deepEqual(await visibleTo(USERS.surgeon), ["all-crew", "for-bravo"]);
  });

  test("crew cannot author or edit messages", async () => {
    await assert.rejects(
      asRole(db, "authenticated", "insert into ground_messages (author, subject, body, sent_at) values ('x', 'y', 'z', now())", [], USERS.alice),
      /permission denied/,
    );
    await assert.rejects(asRole(db, "authenticated", "update ground_messages set body = 'hacked'", [], USERS.bob), /permission denied/);
  });

  test("a read is stamped as the caller, whatever crew_member_id the client sends", async () => {
    // Alice tries to mark the message read on Bob's behalf.
    await asRole(db, "authenticated", "insert into ground_message_reads (message_id, crew_member_id, read_at) values ($1, $2, '2000-01-01')", [toAll, crew.bob], USERS.alice);
    const r = await rows(db, "select crew_member_id, read_at from ground_message_reads where message_id = $1", [toAll]);
    assert.equal(r.length, 1);
    assert.equal(r[0]!.crew_member_id, crew.alice);
    assert.ok((r[0]!.read_at as Date).getFullYear() > 2000);
  });

  test("a message you can't see can't be marked read", async () => {
    await assert.rejects(
      asRole(db, "authenticated", "insert into ground_message_reads (message_id) values ($1)", [toBob], USERS.alice),
      /row-level security/,
    );
  });

  test("reading twice is ignored with on conflict do nothing", async () => {
    await asRole(db, "authenticated", "insert into ground_message_reads (message_id) values ($1) on conflict do nothing", [toAll], USERS.alice);
    assert.equal((await rows(db, "select count(*)::int n from ground_message_reads where message_id = $1", [toAll]))[0]!.n, 1);
  });

  test("crew see only their own reads; oversight sees everyone's", async () => {
    await asRole(db, "authenticated", "insert into ground_message_reads (message_id) values ($1)", [toBob], USERS.bob);
    const mine = await asRole(db, "authenticated", "select crew_member_id from ground_message_reads", [], USERS.bob);
    assert.deepEqual(mine.map((r) => r.crew_member_id), [crew.bob]);
    const all = await asRole(db, "authenticated", "select crew_member_id from ground_message_reads", [], USERS.surgeon);
    assert.equal(all.length, 2);
  });
});
