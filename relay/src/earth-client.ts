import {
  encodeEnvelope,
  parseBatchResponse,
  parseReceiptsResponse,
  signRequest,
  type BatchResponse,
  type UplinkEnvelope,
} from "../../packages/uplink-protocol/index.ts";

export type ProbeResult = { ok: true; rttMs: number } | { ok: false; error: string };

export type SendOutcome =
  /** Earth processed the batch and returned per-entry verdicts. */
  | { kind: "verdict"; response: BatchResponse }
  /** Body over Earth's limit: split the batch, no penalty. */
  | { kind: "too_large" }
  /** Earth refused us (signature, clock, config). Data kept; operator attention needed. */
  | { kind: "refused"; error: string }
  /** Link or server trouble. Data kept; retry with backoff. */
  | { kind: "retry"; error: string };

export type ReceiptsOutcome = { ok: true; receipts: BatchResponse[] } | { ok: false; error: string };

export interface EarthClient {
  probe(): Promise<ProbeResult>;
  sendBatch(envelope: UplinkEnvelope): Promise<SendOutcome>;
  receipts(batchIds: string[]): Promise<ReceiptsOutcome>;
}

export interface EarthClientOptions {
  baseUrl: string;
  spacecraftId: string;
  secret: string;
  requestTimeoutMs: number;
  probeTimeoutMs: number;
  now?: () => number;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? ` (${error.cause.message})` : "";
    return `${error.name}: ${error.message}${cause}`;
  }
  return String(error);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function createEarthClient(options: EarthClientOptions): EarthClient {
  const now = options.now ?? Date.now;

  async function signedPost(path: string, body: Buffer, extraHeaders: Record<string, string>): Promise<Response> {
    return fetch(`${options.baseUrl}${path}`, {
      method: "POST",
      headers: {
        ...signRequest(body, options.spacecraftId, options.secret, now()),
        ...extraHeaders,
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    });
  }

  return {
    async probe() {
      const started = performance.now();
      try {
        const res = await fetch(`${options.baseUrl}/api/uplink/health`, {
          signal: AbortSignal.timeout(options.probeTimeoutMs),
          headers: { "cache-control": "no-store" },
        });
        await res.arrayBuffer();
        if (!res.ok) return { ok: false, error: `probe HTTP ${res.status}` };
        return { ok: true, rttMs: Math.round(performance.now() - started) };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },

    async sendBatch(envelope) {
      let res: Response;
      try {
        // Gzip is part of the payload format, deliberately NOT declared as
        // Content-Encoding: proxies/CDNs would otherwise decompress it and
        // break the signature, which covers the exact compressed bytes.
        res = await signedPost("/api/uplink/batches", encodeEnvelope(envelope), {
          "content-type": "application/octet-stream",
        });
      } catch (error) {
        return { kind: "retry", error: describe(error) };
      }

      let body: unknown;
      try {
        body = await readJson(res);
      } catch (error) {
        return { kind: "retry", error: `reading response: ${describe(error)}` };
      }

      if (res.status === 200) {
        const parsed = parseBatchResponse(body);
        if (!parsed.ok) return { kind: "retry", error: `unparseable verdict: ${parsed.error}` };
        if (parsed.value.batch_id !== envelope.batch_id) return { kind: "retry", error: "verdict for a different batch" };
        return { kind: "verdict", response: parsed.value };
      }
      if (res.status === 413) return { kind: "too_large" };
      const detail = typeof body === "object" && body !== null && "error" in body ? String(body.error) : `HTTP ${res.status}`;
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return { kind: "refused", error: `HTTP ${res.status}: ${detail}` };
      }
      return { kind: "retry", error: `HTTP ${res.status}: ${detail}` };
    },

    async receipts(batchIds) {
      try {
        const res = await signedPost("/api/uplink/receipts", Buffer.from(JSON.stringify({ batch_ids: batchIds })), {
          "content-type": "application/json",
        });
        const body = await readJson(res);
        if (res.status !== 200) return { ok: false, error: `receipts HTTP ${res.status}` };
        const parsed = parseReceiptsResponse(body);
        if (!parsed.ok) return { ok: false, error: parsed.error };
        return { ok: true, receipts: parsed.value.receipts };
      } catch (error) {
        return { ok: false, error: describe(error) };
      }
    },
  };
}
