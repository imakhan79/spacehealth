// End to end: spacecraft Postgres -> relay loop -> signed HTTP -> Mission
// Control handlers -> Earth Postgres -> verdicts -> spacecraft rows synced.
// Then the failure modes that matter in deep space.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, before, beforeEach, describe, test } from "node:test";
import type { PGlite } from "@electric-sql/pglite";
import { handleBatch, handleReceipts, type EarthStore, type HandlerDeps } from "../mission-control/src/lib/handlers.ts";
import { parseBatchResponse, type BatchResponse, type SignedHeaders } from "../packages/uplink-protocol/index.ts";
import { loadConfig, type RelayConfig } from "../relay/src/config.ts";
import { createEarthClient } from "../relay/src/earth-client.ts";
import { initialState, runCycle, type LogFields, type RelayDeps, type RelayState } from "../relay/src/relay.ts";
import { createRelayStore, type RelayStore } from "../relay/src/store.ts";
import { USERS, asRole, bootEarthDb, bootSpacecraftDb, insertTelemetry, relayQueryable, rows, seedCrew } from "./helpers/db.ts";

const SPACECRAFT = "omni-1";
const SECRET = "a".repeat(64);

// ---------------------------------------------------------------------------
// Fake-free Earth: real handlers + real ingest SQL, plus fault injection.
// ---------------------------------------------------------------------------
interface Faults {
  probeDown: boolean;
  ingestFailures: number;
  /** Ingest succeeds on Earth, then the response is lost on the way back. */
  dropResponses: number;
}

function earthStore(earth: PGlite): EarthStore {
  return {
    async ingestBatch(spacecraftId, envelope, compressedBytes): Promise<BatchResponse> {
      const [r] = await asRole(earth, "service_role", "select public.ingest_uplink_batch($1, $2::jsonb, $3) as r", [
        spacecraftId,
        JSON.stringify(envelope),
        compressedBytes,
      ]);
      const parsed = parseBatchResponse(r?.r);
      if (!parsed.ok) throw new Error(parsed.error);
      return parsed.value;
    },
    async receipts(spacecraftId, batchIds): Promise<BatchResponse[]> {
      const found = await asRole(earth, "service_role",
        `select batch_id, results from uplink_batches
          where spacecraft_id = $1 and batch_id = any($2::uuid[]) and completed_at is not null`,
        [spacecraftId, batchIds]);
      return found.map((row) => {
        const parsed = parseBatchResponse({ batch_id: row.batch_id, duplicate: true, results: row.results });
        if (!parsed.ok) throw new Error(parsed.error);
        return parsed.value;
      });
    },
  };
}

function signedHeaders(req: IncomingMessage): SignedHeaders {
  const one = (v: string | string[] | undefined): string | null => (typeof v === "string" ? v : null);
  return {
    spacecraftId: one(req.headers["x-omni-spacecraft"]),
    timestamp: one(req.headers["x-omni-timestamp"]),
    signature: one(req.headers["x-omni-signature"]),
  };
}

async function readBody(req: IncomingMessage): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return new Uint8Array(Buffer.concat(chunks));
}

function startEarth(earth: PGlite, faults: Faults): Promise<{ server: Server; url: string }> {
  const store = earthStore(earth);
  const deps: HandlerDeps = {
    store,
    secretFor: (id) => (id === SPACECRAFT ? SECRET : undefined),
    nowMs: () => Date.now(),
    log: () => undefined,
  };
  const failingStore: EarthStore = {
    ...store,
    async ingestBatch(...args) {
      if (faults.ingestFailures > 0) {
        faults.ingestFailures--;
        throw new Error("simulated Earth DB outage");
      }
      return store.ingestBatch(...args);
    },
  };

  const server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
      };
      if (req.method === "GET" && req.url === "/api/uplink/health") {
        return faults.probeDown ? send(503, { ok: false }) : send(200, { ok: true });
      }
      const body = await readBody(req);
      if (req.method === "POST" && req.url === "/api/uplink/batches") {
        const result = await handleBatch(body, signedHeaders(req), { ...deps, store: failingStore });
        if (faults.dropResponses > 0 && result.status === 200) {
          faults.dropResponses--;
          req.socket.destroy(); // Earth committed; the reply never reaches the spacecraft
          return;
        }
        return send(result.status, result.body);
      }
      if (req.method === "POST" && req.url === "/api/uplink/receipts") {
        const result = await handleReceipts(body, signedHeaders(req), deps);
        return send(result.status, result.body);
      }
      send(404, { error: "not found" });
    })().catch((error: unknown) => {
      res.writeHead(500).end(String(error));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------------

let spacecraft: PGlite;
let earth: PGlite;
let earthServer: { server: Server; url: string };
let faults: Faults;
let crew: { alice: string; bob: string };
let store: RelayStore;
let events: { level: string; event: string; fields: LogFields }[];

function relayConfig(url: string, overrides: Record<string, string> = {}): RelayConfig {
  return loadConfig({
    OMNI_RELAY_DATABASE_URL: "unused-in-tests",
    OMNI_SPACECRAFT_ID: SPACECRAFT,
    OMNI_UPLINK_URL: url,
    OMNI_UPLINK_SECRET: SECRET,
    OMNI_UPLINK_MAX_BATCH_ENTRIES: "20",
    OMNI_UPLINK_REQUEST_TIMEOUT_MS: "5000",
    OMNI_UPLINK_PROBE_TIMEOUT_MS: "1000",
    ...overrides,
  });
}

function relayDeps(config: RelayConfig, relayStore: RelayStore = store): RelayDeps {
  return {
    config,
    store: relayStore,
    earth: createEarthClient({
      baseUrl: config.uplinkUrl,
      spacecraftId: config.spacecraftId,
      secret: config.uplinkSecret,
      requestTimeoutMs: config.requestTimeoutMs,
      probeTimeoutMs: config.probeTimeoutMs,
    }),
    log: (level, event, fields = {}) => events.push({ level, event, fields }),
    newBatchId: randomUUID,
    now: () => new Date(),
    random: () => 0.5,
  };
}

/** Runs cycles until the queue is idle (or a safety limit). */
async function drain(deps: RelayDeps, state: RelayState = initialState(deps.config)): Promise<number> {
  let cycles = 0;
  for (; cycles < 50; cycles++) {
    const wait = await runCycle(state, deps);
    if (wait === deps.config.idlePollMs) break;
    if (wait > 0) throw new Error(`relay backed off unexpectedly: ${JSON.stringify(events.at(-1))}`);
  }
  return cycles;
}

async function count(db: PGlite, sql: string, params: unknown[] = []): Promise<number> {
  const [r] = await rows(db, sql, params);
  return Number(r?.n);
}

/** Make every queued entry due now (skip backoff waits in tests). */
async function makeDue(): Promise<void> {
  await rows(spacecraft, "update uplink_queue set next_attempt_at = now() where sync_status = 'queued_for_earth'");
}

before(async () => {
  faults = { probeDown: false, ingestFailures: 0, dropResponses: 0 };
});

beforeEach(async () => {
  faults.probeDown = false;
  faults.ingestFailures = 0;
  faults.dropResponses = 0;
  events = [];
  spacecraft = await bootSpacecraftDb();
  earth = await bootEarthDb();
  earthServer = await startEarth(earth, faults);
  crew = await seedCrew(spacecraft);
  await insertTelemetry(spacecraft, crew.alice, 50);
  store = createRelayStore(relayQueryable(spacecraft), { entryBackoffBaseMs: 5000, entryBackoffCapMs: 1_800_000 });
});

afterEach(async () => {
  earthServer.server.closeAllConnections();
  await new Promise<void>((resolve) => earthServer.server.close(() => resolve()));
  await spacecraft.close();
  await earth.close();
});

describe("uplink end to end", () => {
  test("drains the whole queue in batches; every row synced on both sides", async () => {
    const deps = relayDeps(relayConfig(earthServer.url));
    await drain(deps);

    assert.equal(await count(spacecraft, "select count(*) n from uplink_queue where sync_status <> 'synced'"), 0);
    assert.equal(await count(spacecraft, "select count(*) n from crew_telemetry where sync_status <> 'synced'"), 0);
    assert.equal(await count(earth, "select count(*) n from spacecraft_records"), 54);
    assert.ok((await count(earth, "select count(*) n from uplink_batches")) >= 3, "54 entries at 20/batch");
    const [link] = await rows(spacecraft, "select status from omni_private.uplink_link_state");
    assert.equal(link?.status, "uplink_active");
  });

  test("an override made after sync reaches Earth as v2", async () => {
    const deps = relayDeps(relayConfig(earthServer.url));
    await asRole(spacecraft, "authenticated",
      "insert into health_alerts (crew_member_id, severity, message) values ($1, 'caution', 'HR up')",
      [crew.alice], USERS.gateway);
    await drain(deps);
    const [alert] = await rows(spacecraft, "select id from health_alerts");

    await asRole(spacecraft, "authenticated",
      "update health_alerts set status = 'overridden', override_reason = 'post-exercise' where id = $1",
      [alert?.id], USERS.alice);
    await drain(deps);

    const [onEarth] = await rows(earth,
      "select row_version, payload->>'status' status, payload->>'overridden_by' by from spacecraft_records where source_id = $1",
      [alert?.id]);
    assert.deepEqual(onEarth, { row_version: 2, status: "overridden", by: crew.alice });
  });

  test("blackout: Earth unreachable -> local_mode, nothing claimed, nothing lost", async () => {
    const deps = relayDeps(relayConfig("http://127.0.0.1:1"));
    const before = await count(spacecraft, "select count(*) n from uplink_queue where sync_status = 'queued_for_earth'");
    const state = initialState(deps.config);

    const waits = [await runCycle(state, deps), await runCycle(state, deps), await runCycle(state, deps)];
    assert.ok(waits[0]! > 0 && waits[2]! > waits[0]!, `link backoff grows: ${waits.join(", ")}`);
    assert.equal(await count(spacecraft, "select count(*) n from uplink_queue where sync_status = 'queued_for_earth'"), before);
    assert.equal(await count(spacecraft, "select count(*) n from uplink_queue where sync_status = 'in_flight'"), 0);
    const [link] = await rows(spacecraft, "select status, consecutive_failures from omni_private.uplink_link_state");
    assert.deepEqual(link, { status: "local_mode", consecutive_failures: 3 });
  });

  test("Earth DB outage mid-pass -> batch released with backoff, then delivered", async () => {
    const deps = relayDeps(relayConfig(earthServer.url));
    faults.ingestFailures = 1;
    const state = initialState(deps.config);

    const wait = await runCycle(state, deps);
    assert.ok(wait > 0, "backs off after a 503");
    const [link] = await rows(spacecraft, "select status from omni_private.uplink_link_state");
    assert.equal(link?.status, "degraded");
    assert.equal(await count(spacecraft, "select count(*) n from uplink_queue where sync_status = 'in_flight'"), 0);
    assert.equal(await count(spacecraft, "select count(*) n from uplink_queue where next_attempt_at > now()"), 20);

    await makeDue();
    await drain(deps, state);
    assert.equal(await count(earth, "select count(*) n from spacecraft_records"), 54);
  });

  test("reply lost after Earth committed -> resend is recognised as duplicate, no double write", async () => {
    const deps = relayDeps(relayConfig(earthServer.url));
    faults.dropResponses = 1;
    const state = initialState(deps.config);

    assert.ok((await runCycle(state, deps)) > 0, "lost reply looks like a failed send");
    await makeDue();
    await drain(deps, state);

    assert.equal(await count(earth, "select count(*) n from spacecraft_records"), 54);
    assert.equal(await count(spacecraft, "select count(*) n from uplink_queue where sync_status <> 'synced'"), 0);
    const dupes = await rows(earth, "select count(*) n from uplink_batches b, jsonb_array_elements(b.results) r where r->>'reason' = 'duplicate'");
    assert.equal(Number(dupes[0]?.n), 20, "the resent 20 entries were acknowledged as duplicates");
  });

  test("relay crashes between Earth's verdict and the local ack -> settled from receipts", async () => {
    let crashOnce = true;
    const crashingStore: RelayStore = {
      ...store,
      async ackBatch(batchId, results) {
        if (crashOnce) {
          crashOnce = false;
          throw new Error("simulated local DB failure during ack");
        }
        return store.ackBatch(batchId, results);
      },
    };
    const deps = relayDeps(relayConfig(earthServer.url), crashingStore);
    const state = initialState(deps.config);

    await assert.rejects(runCycle(state, deps), /simulated local DB failure/);
    assert.equal(await count(spacecraft, "select count(*) n from uplink_queue where sync_status = 'in_flight'"), 20);

    await drain(deps, state);
    assert.ok(events.some((e) => e.event === "orphan_settled"), "orphan settled from Earth's receipt");
    assert.equal(await count(spacecraft, "select count(*) n from uplink_queue where sync_status <> 'synced'"), 0);
    assert.equal(await count(earth, "select count(*) n from spacecraft_records"), 54);
  });

  test("wrong secret -> Earth refuses, link degraded, data retained", async () => {
    const deps = relayDeps(relayConfig(earthServer.url, { OMNI_UPLINK_SECRET: "b".repeat(64) }));
    const wait = await runCycle(initialState(deps.config), deps);
    assert.ok(wait > 0);
    assert.ok(events.some((e) => e.event === "earth_refused_batch"));
    assert.equal(await count(earth, "select count(*) n from uplink_batches"), 0);
    assert.equal(await count(spacecraft, "select count(*) n from uplink_queue where sync_status = 'queued_for_earth'"), 54);
  });

  test("same version with different content is flagged as a conflict on both sides", async () => {
    const deps = relayDeps(relayConfig(earthServer.url));
    await drain(deps);
    const [row] = await rows(spacecraft, "select id from crew_members where callsign = 'ALPHA'");

    // Simulate divergence: the relay (bypassing triggers) rewrites v1 content and re-queues it.
    await asRole(spacecraft, "omni_relay", "update crew_members set full_name = 'Tampered', sync_status = 'queued_for_earth' where id = $1", [row?.id]);
    await rows(spacecraft,
      `insert into uplink_queue (source_table, source_id, operation, row_version, payload, priority)
       select 'crew_members', id, 'upsert', row_version, to_jsonb(c), 4 from crew_members c where id = $1`,
      [row?.id]);
    await drain(deps);

    const [local] = await rows(spacecraft, "select sync_status from crew_members where id = $1", [row?.id]);
    assert.equal(local?.sync_status, "conflict");
    assert.equal(await count(earth, "select count(*) n from spacecraft_record_conflicts"), 1);
    const [kept] = await rows(earth, "select payload->>'full_name' name from spacecraft_records where source_id = $1", [row?.id]);
    assert.equal(kept?.name, "Alice", "Earth keeps the first version it received");
  });
});
