// Framework-free request handling for the uplink endpoints. Route files adapt
// Next.js Requests to these; tests drive them directly over plain HTTP.
import {
  MAX_COMPRESSED_BYTES,
  decodeEnvelope,
  parseReceiptsRequest,
  verifyRequest,
  type BatchResponse,
  type ReceiptsResponse,
  type SignedHeaders,
  type UplinkEnvelope,
} from "../../../packages/uplink-protocol/index.ts";

export interface EarthStore {
  ingestBatch(spacecraftId: string, envelope: UplinkEnvelope, compressedBytes: number): Promise<BatchResponse>;
  receipts(spacecraftId: string, batchIds: string[]): Promise<BatchResponse[]>;
}

export interface HandlerDeps {
  store: EarthStore | null;
  secretFor: (spacecraftId: string) => string | undefined;
  nowMs: () => number;
  log: (event: string, fields: Record<string, string | number | boolean>) => void;
}

export type HandlerResult =
  | { status: 200; body: BatchResponse | ReceiptsResponse }
  | { status: 400 | 401 | 403 | 413 | 503; body: { error: string } };

function readHeader(headers: Headers, name: string): string | null {
  return headers.get(name);
}

export function signedHeadersFrom(headers: Headers): SignedHeaders {
  return {
    spacecraftId: readHeader(headers, "x-omni-spacecraft"),
    timestamp: readHeader(headers, "x-omni-timestamp"),
    signature: readHeader(headers, "x-omni-signature"),
  };
}

export async function handleBatch(body: Uint8Array, headers: SignedHeaders, deps: HandlerDeps): Promise<HandlerResult> {
  if (body.byteLength === 0) return { status: 400, body: { error: "empty body" } };
  if (body.byteLength > MAX_COMPRESSED_BYTES) return { status: 413, body: { error: "batch too large" } };

  const auth = verifyRequest(body, headers, deps.secretFor, deps.nowMs());
  if (!auth.ok) {
    deps.log("uplink.auth_failed", { reason: auth.error });
    return { status: 401, body: { error: auth.error } };
  }

  const decoded = decodeEnvelope(body);
  if (!decoded.ok) return { status: 400, body: { error: decoded.error } };
  if (decoded.value.spacecraft_id !== auth.value.spacecraftId) {
    return { status: 403, body: { error: "envelope spacecraft_id does not match signer" } };
  }

  if (deps.store === null) return { status: 503, body: { error: "earth database not configured" } };

  try {
    const response = await deps.store.ingestBatch(auth.value.spacecraftId, decoded.value, body.byteLength);
    deps.log("uplink.batch_ingested", {
      spacecraft: auth.value.spacecraftId,
      batch: response.batch_id,
      entries: response.results.length,
      duplicate: response.duplicate,
    });
    return { status: 200, body: response };
  } catch (error) {
    // 503 tells the relay to keep the batch and retry with backoff.
    deps.log("uplink.ingest_failed", {
      batch: decoded.value.batch_id,
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: 503, body: { error: "ingest failed; retry later" } };
  }
}

export async function handleReceipts(body: Uint8Array, headers: SignedHeaders, deps: HandlerDeps): Promise<HandlerResult> {
  if (body.byteLength > 64 * 1024) return { status: 413, body: { error: "request too large" } };

  const auth = verifyRequest(body, headers, deps.secretFor, deps.nowMs());
  if (!auth.ok) return { status: 401, body: { error: auth.error } };

  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(body).toString("utf8"));
  } catch {
    return { status: 400, body: { error: "body must be JSON" } };
  }
  const parsed = parseReceiptsRequest(raw);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };

  if (deps.store === null) return { status: 503, body: { error: "earth database not configured" } };

  try {
    const receipts = await deps.store.receipts(auth.value.spacecraftId, parsed.value.batch_ids);
    return { status: 200, body: { receipts } };
  } catch (error) {
    deps.log("uplink.receipts_failed", { error: error instanceof Error ? error.message : String(error) });
    return { status: 503, body: { error: "receipts unavailable; retry later" } };
  }
}
