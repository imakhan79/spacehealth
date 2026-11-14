import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, test } from "node:test";
import {
  decodeEnvelope,
  encodeEnvelope,
  signRequest,
  verifyRequest,
  type UplinkEnvelope,
} from "../packages/uplink-protocol/index.ts";
import { fullJitterMs } from "../relay/src/backoff.ts";

const SECRET = "s".repeat(64);
const secretFor = (id: string): string | undefined => (id === "omni-1" ? SECRET : undefined);

function envelope(): UplinkEnvelope {
  const id = randomUUID();
  return {
    protocol: 1,
    spacecraft_id: "omni-1",
    batch_id: randomUUID(),
    created_at: new Date().toISOString(),
    entries: [{ queue_id: 1, source_table: "crew_telemetry", source_id: id, operation: "upsert", row_version: 1, payload: { id, value: 72 } }],
  };
}

function headersOf(h: Record<string, string>) {
  return { spacecraftId: h["x-omni-spacecraft"] ?? null, timestamp: h["x-omni-timestamp"] ?? null, signature: h["x-omni-signature"] ?? null };
}

describe("signing", () => {
  const now = 1_800_000_000_000;
  const body = encodeEnvelope(envelope());

  test("round trip verifies", () => {
    const h = signRequest(body, "omni-1", SECRET, now);
    assert.deepEqual(verifyRequest(body, headersOf(h), secretFor, now), { ok: true, value: { spacecraftId: "omni-1" } });
  });

  test("any byte flip, wrong key, unknown craft or stale clock is rejected", () => {
    const h = signRequest(body, "omni-1", SECRET, now);
    const tampered = Buffer.from(body);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1;
    assert.equal(verifyRequest(tampered, headersOf(h), secretFor, now).ok, false);
    assert.equal(verifyRequest(body, headersOf(signRequest(body, "omni-1", "x".repeat(64), now)), secretFor, now).ok, false);
    assert.equal(verifyRequest(body, headersOf(signRequest(body, "omni-9", SECRET, now)), secretFor, now).ok, false);
    assert.equal(verifyRequest(body, headersOf(h), secretFor, now + 7 * 3600 * 1000).ok, false);
  });
});

describe("envelope", () => {
  test("encode/decode round trip", () => {
    const e = envelope();
    assert.deepEqual(decodeEnvelope(encodeEnvelope(e)), { ok: true, value: e });
  });

  test("zip bombs and malformed entries are rejected", () => {
    const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024));
    assert.equal(decodeEnvelope(bomb).ok, false);
    const bad = envelope();
    const first = bad.entries[0];
    assert.ok(first);
    first.payload = { id: randomUUID() };
    const result = decodeEnvelope(encodeEnvelope(bad));
    assert.equal(result.ok, false);
  });
});

describe("backoff", () => {
  test("full jitter grows exponentially and respects the cap", () => {
    const max = () => 0.999999;
    assert.ok(fullJitterMs(1, 1000, 60_000, max) < 1000);
    assert.ok(fullJitterMs(4, 1000, 60_000, max) >= 7999);
    assert.ok(fullJitterMs(40, 1000, 60_000, max) < 60_000);
    assert.equal(fullJitterMs(5, 1000, 60_000, () => 0), 0);
  });
});
