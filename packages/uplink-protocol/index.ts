// OMNI uplink wire protocol, shared by the spacecraft relay and Earth's
// Mission Control. Pure Node (crypto + zlib), erasable TypeScript only, so the
// relay can run it directly with Node's type stripping.
//
// Request:  POST body = gzip(JSON envelope)  (receipts: plain JSON)
// Headers:  x-omni-spacecraft, x-omni-timestamp (unix ms), x-omni-signature
// Signature = hex HMAC-SHA256(secret, `${PROTOCOL_VERSION}.${timestamp}.${spacecraftId}.${sha256hex(body)}`)
//
// Batches are idempotent on batch_id and entries on (source_table, source_id,
// row_version), so any message may be safely re-sent after a dropped link.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

export const PROTOCOL_VERSION = 1;

export const HEADER_SPACECRAFT = "x-omni-spacecraft";
export const HEADER_TIMESTAMP = "x-omni-timestamp";
export const HEADER_SIGNATURE = "x-omni-signature";

/** Vercel functions accept ~4.5 MB bodies; stay well under it. */
export const MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;
/** Zip-bomb guard on Earth. */
export const MAX_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
export const MAX_ENTRIES_PER_BATCH = 2000;
/** Generous: spacecraft clocks drift, and replays are harmless (idempotent). */
export const DEFAULT_MAX_CLOCK_SKEW_MS = 6 * 60 * 60 * 1000;

export const REPLICATED_TABLES = ["crew_members", "crew_telemetry", "health_alerts", "ambient_acoustics"] as const;
export type ReplicatedTable = (typeof REPLICATED_TABLES)[number];

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface UplinkEntry {
  queue_id: number;
  source_table: ReplicatedTable;
  source_id: string;
  operation: "upsert" | "tombstone";
  row_version: number;
  payload: { [key: string]: JsonValue };
}

export interface UplinkEnvelope {
  protocol: typeof PROTOCOL_VERSION;
  spacecraft_id: string;
  batch_id: string;
  created_at: string;
  entries: UplinkEntry[];
}

export type EntryStatus = "accepted" | "conflict" | "rejected";

export interface EntryResult {
  queue_id: number;
  status: EntryStatus;
  reason?: string;
}

export interface BatchResponse {
  batch_id: string;
  duplicate: boolean;
  results: EntryResult[];
}

export interface ReceiptsRequest {
  batch_ids: string[];
}

export interface ReceiptsResponse {
  /** Batches Earth has fully processed. Absent ids were never received. */
  receipts: BatchResponse[];
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

export function sha256Hex(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

function signingInput(timestamp: string, spacecraftId: string, body: Uint8Array): string {
  return `${PROTOCOL_VERSION}.${timestamp}.${spacecraftId}.${sha256Hex(body)}`;
}

export function signRequest(
  body: Uint8Array,
  spacecraftId: string,
  secret: string,
  nowMs: number,
): Record<string, string> {
  const timestamp = String(nowMs);
  const signature = createHmac("sha256", secret).update(signingInput(timestamp, spacecraftId, body)).digest("hex");
  return {
    [HEADER_SPACECRAFT]: spacecraftId,
    [HEADER_TIMESTAMP]: timestamp,
    [HEADER_SIGNATURE]: signature,
  };
}

export interface SignedHeaders {
  spacecraftId: string | null;
  timestamp: string | null;
  signature: string | null;
}

export function verifyRequest(
  body: Uint8Array,
  headers: SignedHeaders,
  secretFor: (spacecraftId: string) => string | undefined,
  nowMs: number,
  maxSkewMs: number = DEFAULT_MAX_CLOCK_SKEW_MS,
): Result<{ spacecraftId: string }> {
  const { spacecraftId, timestamp, signature } = headers;
  if (!spacecraftId || !timestamp || !signature) return { ok: false, error: "missing signature headers" };
  if (!/^\d{1,16}$/.test(timestamp)) return { ok: false, error: "malformed timestamp" };
  if (Math.abs(nowMs - Number(timestamp)) > maxSkewMs) return { ok: false, error: "timestamp outside allowed skew" };
  if (!/^[0-9a-f]{64}$/.test(signature)) return { ok: false, error: "malformed signature" };

  const secret = secretFor(spacecraftId);
  if (secret === undefined) return { ok: false, error: "unknown spacecraft" };

  const expected = createHmac("sha256", secret).update(signingInput(timestamp, spacecraftId, body)).digest();
  const given = Buffer.from(signature, "hex");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, error: "bad signature" };
  }
  return { ok: true, value: { spacecraftId } };
}

// ---------------------------------------------------------------------------
// Envelope encoding
// ---------------------------------------------------------------------------

export function encodeEnvelope(envelope: UplinkEnvelope): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(envelope), "utf8"), { level: 9 });
}

export function decodeEnvelope(compressed: Uint8Array): Result<UplinkEnvelope> {
  if (compressed.byteLength > MAX_COMPRESSED_BYTES) return { ok: false, error: "batch too large" };
  let raw: unknown;
  try {
    const json = gunzipSync(compressed, { maxOutputLength: MAX_DECOMPRESSED_BYTES }).toString("utf8");
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `undecodable body: ${error instanceof Error ? error.message : String(error)}` };
  }
  return parseEnvelope(raw);
}

// ---------------------------------------------------------------------------
// Runtime validation (both ends treat the other side as untrusted input)
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return isRecord(value);
}

function isReplicatedTable(value: unknown): value is ReplicatedTable {
  return typeof value === "string" && (REPLICATED_TABLES as readonly string[]).includes(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

export function parseEnvelope(raw: unknown): Result<UplinkEnvelope> {
  if (!isRecord(raw)) return { ok: false, error: "envelope is not an object" };
  if (raw.protocol !== PROTOCOL_VERSION) return { ok: false, error: `unsupported protocol ${String(raw.protocol)}` };
  if (typeof raw.spacecraft_id !== "string" || raw.spacecraft_id.length === 0) {
    return { ok: false, error: "spacecraft_id missing" };
  }
  if (!isUuid(raw.batch_id)) return { ok: false, error: "batch_id must be a uuid" };
  if (typeof raw.created_at !== "string" || Number.isNaN(Date.parse(raw.created_at))) {
    return { ok: false, error: "created_at must be an ISO timestamp" };
  }
  if (!Array.isArray(raw.entries) || raw.entries.length === 0) return { ok: false, error: "entries must be non-empty" };
  if (raw.entries.length > MAX_ENTRIES_PER_BATCH) return { ok: false, error: "too many entries" };

  const entries: UplinkEntry[] = [];
  const seen = new Set<number>();
  for (const [i, e] of raw.entries.entries()) {
    if (!isRecord(e)) return { ok: false, error: `entry ${i} is not an object` };
    if (!isPositiveInt(e.queue_id) || seen.has(e.queue_id)) return { ok: false, error: `entry ${i}: bad queue_id` };
    if (!isReplicatedTable(e.source_table)) return { ok: false, error: `entry ${i}: bad source_table` };
    if (!isUuid(e.source_id)) return { ok: false, error: `entry ${i}: bad source_id` };
    if (e.operation !== "upsert" && e.operation !== "tombstone") return { ok: false, error: `entry ${i}: bad operation` };
    if (!isPositiveInt(e.row_version)) return { ok: false, error: `entry ${i}: bad row_version` };
    if (!isJsonObject(e.payload)) return { ok: false, error: `entry ${i}: payload must be an object` };
    if (e.payload.id !== e.source_id) return { ok: false, error: `entry ${i}: payload.id does not match source_id` };
    seen.add(e.queue_id);
    entries.push({
      queue_id: e.queue_id,
      source_table: e.source_table,
      source_id: e.source_id,
      operation: e.operation,
      row_version: e.row_version,
      payload: e.payload,
    });
  }

  return {
    ok: true,
    value: {
      protocol: PROTOCOL_VERSION,
      spacecraft_id: raw.spacecraft_id,
      batch_id: raw.batch_id,
      created_at: raw.created_at,
      entries,
    },
  };
}

function parseEntryResult(raw: unknown): EntryResult | null {
  if (!isRecord(raw) || !isPositiveInt(raw.queue_id)) return null;
  if (raw.status !== "accepted" && raw.status !== "conflict" && raw.status !== "rejected") return null;
  const result: EntryResult = { queue_id: raw.queue_id, status: raw.status };
  if (typeof raw.reason === "string") result.reason = raw.reason;
  return result;
}

export function parseBatchResponse(raw: unknown): Result<BatchResponse> {
  if (!isRecord(raw) || !isUuid(raw.batch_id) || !Array.isArray(raw.results)) {
    return { ok: false, error: "malformed batch response" };
  }
  const results: EntryResult[] = [];
  for (const item of raw.results) {
    const parsed = parseEntryResult(item);
    if (parsed === null) return { ok: false, error: "malformed entry result" };
    results.push(parsed);
  }
  return { ok: true, value: { batch_id: raw.batch_id, duplicate: raw.duplicate === true, results } };
}

export function parseReceiptsRequest(raw: unknown): Result<ReceiptsRequest> {
  if (!isRecord(raw) || !Array.isArray(raw.batch_ids)) return { ok: false, error: "batch_ids required" };
  if (raw.batch_ids.length > 500 || !raw.batch_ids.every(isUuid)) return { ok: false, error: "bad batch_ids" };
  return { ok: true, value: { batch_ids: raw.batch_ids } };
}

export function parseReceiptsResponse(raw: unknown): Result<ReceiptsResponse> {
  if (!isRecord(raw) || !Array.isArray(raw.receipts)) return { ok: false, error: "malformed receipts response" };
  const receipts: BatchResponse[] = [];
  for (const r of raw.receipts) {
    const parsed = parseBatchResponse(r);
    if (!parsed.ok) return parsed;
    receipts.push(parsed.value);
  }
  return { ok: true, value: { receipts } };
}
