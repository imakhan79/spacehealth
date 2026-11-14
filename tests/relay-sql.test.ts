// Phase 3: relay state transitions, exercised through the same store the
// worker uses, running as the omni_relay role.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { createRelayStore, type RelayStore } from "../relay/src/store.ts";
import { USERS, asRole, bootSpacecraftDb, insertTelemetry, relayQueryable, rows, seedCrew } from "./helpers/db.ts";

let db: PGlite;
let store: RelayStore;
let crew: { alice: string; bob: string };

beforeEach(async () => {
  db = await bootSpacecraftDb();
  crew = await seedCrew(db);
  store = createRelayStore(relayQueryable(db), { entryBackoffBaseMs: 5000, entryBackoffCapMs: 1_800_000 });
});

async function statusOf(table: string, id: string): Promise<string> {
  const [r] = await rows(db, `select sync_status from ${table} where id = $1`, [id]);
  return String(r?.sync_status);
}

describe("claim", () => {
  test("claims most urgent first and marks source rows in_flight", async () => {
    await insertTelemetry(db, crew.alice, 3);
    await asRole(db, "authenticated",
      "insert into health_alerts (crew_member_id, severity, message) values ($1, 'emergency', 'SpO2 critical')",
      [crew.alice], USERS.gateway);

    const batch = randomUUID();
    const entries = await store.claimBatch(batch, 2, 10_000_000);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]?.source_table, "health_alerts", "emergency alert (priority 0) goes first");
    assert.equal(await statusOf("health_alerts", entries[0]?.source_id ?? ""), "in_flight");
    assert.equal(typeof entries[0]?.queue_id, "number");
  });

  test("respects the byte budget but always takes at least one entry", async () => {
    await insertTelemetry(db, crew.alice, 5);
    const one = await store.claimBatch(randomUUID(), 100, 1);
    assert.equal(one.length, 1);
  });

  test("crew cannot call relay functions", async () => {
    await assert.rejects(
      asRole(db, "authenticated", "select * from omni_private.relay_claim_batch(gen_random_uuid(), 10, 1000)", [], USERS.alice),
      /permission denied/,
    );
  });
});

describe("ack", () => {
  test("accepted entries mark rows synced with earth_ack_version", async () => {
    const batch = randomUUID();
    const entries = await store.claimBatch(batch, 10, 10_000_000);
    const counts = await store.ackBatch(batch, entries.map((e) => ({ queue_id: e.queue_id, status: "accepted" as const })));
    assert.deepEqual(counts, { accepted: entries.length, conflicted: 0, released: 0 });
    const [r] = await rows(db, "select sync_status, earth_ack_version from crew_members where id = $1", [entries[0]?.source_id]);
    assert.deepEqual(r, { sync_status: "synced", earth_ack_version: 1 });
  });

  test("a late ACK never marks a newer local edit as synced", async () => {
    await asRole(db, "authenticated",
      "insert into health_alerts (crew_member_id, severity, message) values ($1, 'caution', 'HR up')",
      [crew.alice], USERS.gateway);
    const [alert] = await rows(db, "select id from health_alerts");
    const alertId = String(alert?.id);
    await rows(db, "delete from uplink_queue where source_table <> 'health_alerts'");

    const batch = randomUUID();
    const [sent] = await store.claimBatch(batch, 10, 10_000_000);
    assert.equal(sent?.row_version, 1);

    // Astronaut overrides while v1 is in flight -> v2 queued separately.
    await asRole(db, "authenticated",
      "update health_alerts set status = 'overridden', override_reason = 'exercise' where id = $1",
      [alertId], USERS.alice);

    await store.ackBatch(batch, [{ queue_id: sent?.queue_id ?? 0, status: "accepted" }]);
    const [after] = await rows(db, "select sync_status, row_version, earth_ack_version from health_alerts where id = $1", [alertId]);
    assert.deepEqual(after, { sync_status: "queued_for_earth", row_version: 2, earth_ack_version: 1 });
  });

  test("conflicts flag the row; entries without a verdict are released", async () => {
    const batch = randomUUID();
    const entries = await store.claimBatch(batch, 2, 10_000_000);
    const [first, second] = entries;
    const counts = await store.ackBatch(batch, [{ queue_id: first?.queue_id ?? 0, status: "conflict", reason: "diverged" }]);
    assert.deepEqual(counts, { accepted: 0, conflicted: 1, released: 1 });
    assert.equal(await statusOf("crew_members", first?.source_id ?? ""), "conflict");
    assert.equal(await statusOf("crew_members", second?.source_id ?? ""), "queued_for_earth");
    const [q] = await rows(db, "select last_error from uplink_queue where id = $1", [first?.queue_id]);
    assert.equal(q?.last_error, "conflict: diverged");
  });

  test("duplicate ACKs are harmless", async () => {
    const batch = randomUUID();
    const entries = await store.claimBatch(batch, 10, 10_000_000);
    const verdicts = entries.map((e) => ({ queue_id: e.queue_id, status: "accepted" as const }));
    await store.ackBatch(batch, verdicts);
    assert.deepEqual(await store.ackBatch(batch, verdicts), { accepted: 0, conflicted: 0, released: 0 });
  });
});

describe("release", () => {
  test("failed send requeues with backoff and keeps every entry", async () => {
    const batch = randomUUID();
    const entries = await store.claimBatch(batch, 10, 10_000_000);
    const released = await store.releaseBatch(batch, "DSN dropped", true);
    assert.equal(released, entries.length);
    const q = await rows(db, "select sync_status, batch_id, last_error, next_attempt_at > now() as delayed from uplink_queue");
    assert.ok(q.every((r) => r.sync_status === "queued_for_earth" && r.batch_id === null && r.last_error === "DSN dropped"));
    assert.equal(await statusOf("crew_members", entries[0]?.source_id ?? ""), "queued_for_earth");
    // Backoff applied: nothing is due right now.
    assert.equal((await store.claimBatch(randomUUID(), 10, 10_000_000)).length, 0);
  });

  test("an entry superseded during flight is dropped, not duplicated", async () => {
    await rows(db, "delete from uplink_queue");
    await asRole(db, "authenticated",
      "insert into health_alerts (crew_member_id, severity, message) values ($1, 'caution', 'HR up')",
      [crew.alice], USERS.gateway);
    const batch = randomUUID();
    await store.claimBatch(batch, 10, 10_000_000);
    await asRole(db, "authenticated",
      "update health_alerts set status = 'acknowledged'", [], USERS.alice);
    await store.releaseBatch(batch, "timeout", true);
    const q = await rows(db, "select row_version, sync_status from uplink_queue order by id");
    assert.deepEqual(q, [{ row_version: 2, sync_status: "queued_for_earth" }]);
  });

  test("link status is readable by crew only", async () => {
    await store.recordLink("uplink_active", 1234, null, true, false);
    const [s] = await asRole(db, "authenticated", "select status, rtt_ms from get_link_status()", [], USERS.alice);
    assert.deepEqual(s, { status: "uplink_active", rtt_ms: 1234 });
    await assert.rejects(asRole(db, "anon", "select * from get_link_status()"), /permission denied/);
  });
});
