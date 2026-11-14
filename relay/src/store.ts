// Thin, typed wrapper over the omni_private.relay_* SQL functions. All state
// transitions happen inside those functions; this file only validates the
// rows coming back (pg returns int8 as strings, PGlite as numbers).
import type {
  EntryResult,
  JsonValue,
  ReplicatedTable,
  UplinkEntry,
} from "../../packages/uplink-protocol/index.ts";
import { REPLICATED_TABLES } from "../../packages/uplink-protocol/index.ts";

/** Minimal surface satisfied by a pg Pool adapter and by PGlite in tests. */
export interface Queryable {
  query(text: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
}

export type LinkStatus = "local_mode" | "uplink_active" | "degraded";

export interface InFlightBatch {
  batchId: string;
  entries: number;
}

export interface AckCounts {
  accepted: number;
  conflicted: number;
  released: number;
}

export interface RelayStore {
  claimBatch(batchId: string, maxEntries: number, maxBytes: number): Promise<UplinkEntry[]>;
  ackBatch(batchId: string, results: EntryResult[]): Promise<AckCounts>;
  releaseBatch(batchId: string, error: string, penalise: boolean): Promise<number>;
  inFlightBatches(): Promise<InFlightBatch[]>;
  purgeSynced(): Promise<number>;
  recordLink(status: LinkStatus, rttMs: number | null, error: string | null, contact: boolean, batchSent: boolean): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInt(value: unknown, field: string): number {
  const n = typeof value === "string" ? Number(value) : typeof value === "bigint" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) throw new Error(`relay store: ${field} is not an integer`);
  return n;
}

function toTable(value: unknown): ReplicatedTable {
  if (typeof value === "string" && (REPLICATED_TABLES as readonly string[]).includes(value)) {
    return value as ReplicatedTable;
  }
  throw new Error(`relay store: unexpected source_table ${String(value)}`);
}

function toPayload(value: unknown): { [key: string]: JsonValue } {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (!isRecord(parsed)) throw new Error("relay store: payload is not an object");
  return parsed as { [key: string]: JsonValue };
}

function toEntry(row: unknown): UplinkEntry {
  if (!isRecord(row)) throw new Error("relay store: claimed row is not an object");
  const operation = row.operation;
  if (operation !== "upsert" && operation !== "tombstone") throw new Error("relay store: bad operation");
  if (typeof row.source_id !== "string") throw new Error("relay store: bad source_id");
  return {
    queue_id: toInt(row.id, "id"),
    source_table: toTable(row.source_table),
    source_id: row.source_id,
    operation,
    row_version: toInt(row.row_version, "row_version"),
    payload: toPayload(row.payload),
  };
}

export interface StoreBackoff {
  entryBackoffBaseMs: number;
  entryBackoffCapMs: number;
}

export function createRelayStore(db: Queryable, backoff: StoreBackoff): RelayStore {
  return {
    async claimBatch(batchId, maxEntries, maxBytes) {
      const { rows } = await db.query(
        "select id, source_table, source_id, operation, row_version, payload from omni_private.relay_claim_batch($1, $2, $3)",
        [batchId, maxEntries, maxBytes],
      );
      return rows.map(toEntry);
    },

    async ackBatch(batchId, results) {
      const { rows } = await db.query(
        "select accepted, conflicted, released from omni_private.relay_ack_batch($1, $2::jsonb)",
        [batchId, JSON.stringify(results)],
      );
      const row = rows[0];
      if (!isRecord(row)) throw new Error("relay store: ack returned no row");
      return {
        accepted: toInt(row.accepted, "accepted"),
        conflicted: toInt(row.conflicted, "conflicted"),
        released: toInt(row.released, "released"),
      };
    },

    async releaseBatch(batchId, error, penalise) {
      const { rows } = await db.query(
        "select omni_private.relay_release_batch($1, $2, $3, $4, $5) as released",
        [batchId, error, backoff.entryBackoffBaseMs, backoff.entryBackoffCapMs, penalise],
      );
      const row = rows[0];
      return isRecord(row) ? toInt(row.released, "released") : 0;
    },

    async inFlightBatches() {
      const { rows } = await db.query("select batch_id, entries from omni_private.relay_in_flight_batches()");
      return rows.map((row) => {
        if (!isRecord(row) || typeof row.batch_id !== "string") throw new Error("relay store: bad in-flight row");
        return { batchId: row.batch_id, entries: toInt(row.entries, "entries") };
      });
    },

    async purgeSynced() {
      const { rows } = await db.query("select omni_private.relay_purge_synced() as purged");
      const row = rows[0];
      return isRecord(row) ? toInt(row.purged, "purged") : 0;
    },

    async recordLink(status, rttMs, error, contact, batchSent) {
      await db.query("select omni_private.relay_record_link($1::public.uplink_link_status, $2, $3, $4, $5)", [
        status,
        rttMs,
        error,
        contact,
        batchSent,
      ]);
    },
  };
}
