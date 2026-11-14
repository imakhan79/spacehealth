import "server-only";
import pg from "pg";
import {
  parseBatchResponse,
  type BatchResponse,
  type UplinkEnvelope,
} from "../../../packages/uplink-protocol/index.ts";
import type { EarthStore } from "./handlers.ts";

// Direct Postgres access as the least-privilege omni_ingest role (Supabase
// transaction pooler). One small pool per serverless instance.
let pool: pg.Pool | null = null;

function getPool(connectionString: string): pg.Pool {
  if (pool === null) {
    pool = new pg.Pool({
      connectionString,
      max: 3,
      connectionTimeoutMillis: 8_000,
      idleTimeoutMillis: 10_000,
      statement_timeout: 30_000,
      ssl: { rejectUnauthorized: false },
    });
    pool.on("error", (error) => console.error(JSON.stringify({ event: "pg_idle_error", error: error.message })));
  }
  return pool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPgStore(connectionString: string): EarthStore {
  return {
    async ingestBatch(spacecraftId, envelope: UplinkEnvelope, compressedBytes): Promise<BatchResponse> {
      const { rows } = await getPool(connectionString).query(
        "select public.ingest_uplink_batch($1, $2::jsonb, $3) as result",
        [spacecraftId, JSON.stringify(envelope), compressedBytes],
      );
      const first: unknown = rows[0];
      const parsed = parseBatchResponse(isRecord(first) ? first.result : null);
      if (!parsed.ok) throw new Error(`ingest_uplink_batch returned ${parsed.error}`);
      return parsed.value;
    },

    async receipts(spacecraftId, batchIds): Promise<BatchResponse[]> {
      if (batchIds.length === 0) return [];
      const { rows } = await getPool(connectionString).query(
        `select batch_id, results from public.uplink_batches
          where spacecraft_id = $1 and batch_id = any($2::uuid[]) and completed_at is not null`,
        [spacecraftId, batchIds],
      );
      return rows.map((row: unknown) => {
        const r = isRecord(row) ? row : {};
        const parsed = parseBatchResponse({ batch_id: r.batch_id, duplicate: true, results: r.results });
        if (!parsed.ok) throw new Error(`stored receipt is ${parsed.error}`);
        return parsed.value;
      });
    },
  };
}

export interface BatchSummary {
  batchId: string;
  spacecraftId: string;
  entryCount: number;
  compressedBytes: number;
  receivedAt: string;
}

export interface RecordSummary {
  sourceTable: string;
  sourceId: string;
  rowVersion: number;
  receivedAt: string;
  /** Short human summary of the payload, built server-side. */
  detail: string;
}

export interface Overview {
  batches: BatchSummary[];
  records: RecordSummary[];
  totals: { table: string; count: number }[];
  conflicts: number;
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function describePayload(table: string, payload: Record<string, unknown>): string {
  switch (table) {
    case "crew_telemetry":
      return `${str(payload.metric)} = ${str(payload.value)} ${str(payload.unit)} @ ${str(payload.recorded_at)}`;
    case "health_alerts":
      return `${str(payload.severity).toUpperCase()} · ${str(payload.status)} · ${str(payload.message)}${
        payload.override_reason ? ` (override: ${str(payload.override_reason)})` : ""
      }`;
    case "ambient_acoustics":
      return `${str(payload.module_id)} LAeq ${str(payload.laeq_dba)} dBA${payload.limit_exceeded ? " · LIMIT EXCEEDED" : ""}`;
    case "crew_members":
      return `${str(payload.callsign)} · ${str(payload.role)}`;
    default:
      return "";
  }
}

export async function overview(connectionString: string): Promise<Overview> {
  const db = getPool(connectionString);
  const [batches, records, totals, conflicts] = await Promise.all([
    db.query(
      `select batch_id, spacecraft_id, entry_count, compressed_bytes, received_at
         from public.uplink_batches order by received_at desc limit 15`,
    ),
    db.query(
      `select source_table, source_id, row_version, last_received_at, payload
         from public.spacecraft_records order by last_received_at desc, source_table limit 40`,
    ),
    db.query("select source_table, count(*)::int n from public.spacecraft_records group by 1 order by 1"),
    db.query("select count(*)::int n from public.spacecraft_record_conflicts"),
  ]);

  return {
    batches: batches.rows.map((r: Record<string, unknown>) => ({
      batchId: str(r.batch_id),
      spacecraftId: str(r.spacecraft_id),
      entryCount: Number(r.entry_count),
      compressedBytes: Number(r.compressed_bytes),
      receivedAt: r.received_at instanceof Date ? r.received_at.toISOString() : str(r.received_at),
    })),
    records: records.rows.map((r: Record<string, unknown>) => ({
      sourceTable: str(r.source_table),
      sourceId: str(r.source_id),
      rowVersion: Number(r.row_version),
      receivedAt: r.last_received_at instanceof Date ? r.last_received_at.toISOString() : str(r.last_received_at),
      detail: describePayload(str(r.source_table), isRecord(r.payload) ? r.payload : {}),
    })),
    totals: totals.rows.map((r: Record<string, unknown>) => ({ table: str(r.source_table), count: Number(r.n) })),
    conflicts: Number((conflicts.rows[0] as Record<string, unknown> | undefined)?.n ?? 0),
  };
}
