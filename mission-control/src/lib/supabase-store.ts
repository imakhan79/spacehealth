import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  parseBatchResponse,
  type BatchResponse,
  type UplinkEnvelope,
} from "../../../packages/uplink-protocol/index.ts";
import type { Database, Json } from "./earth-database.types.ts";
import type { EarthStore } from "./handlers.ts";

type EarthClient = SupabaseClient<Database>;

function envelopeToJson(envelope: UplinkEnvelope): Json {
  return {
    protocol: envelope.protocol,
    spacecraft_id: envelope.spacecraft_id,
    batch_id: envelope.batch_id,
    created_at: envelope.created_at,
    entries: envelope.entries.map((e) => ({
      queue_id: e.queue_id,
      source_table: e.source_table,
      source_id: e.source_id,
      operation: e.operation,
      row_version: e.row_version,
      payload: e.payload,
    })),
  };
}

export function createEarthClient(url: string, serverKey: string): EarthClient {
  return createClient<Database>(url, serverKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function createSupabaseStore(client: EarthClient): EarthStore {
  return {
    async ingestBatch(spacecraftId, envelope, compressedBytes): Promise<BatchResponse> {
      const { data, error } = await client.rpc("ingest_uplink_batch", {
        p_spacecraft_id: spacecraftId,
        p_envelope: envelopeToJson(envelope),
        p_compressed_bytes: compressedBytes,
      });
      if (error) throw new Error(`ingest_uplink_batch: ${error.message}`);
      const parsed = parseBatchResponse(data);
      if (!parsed.ok) throw new Error(`ingest_uplink_batch returned ${parsed.error}`);
      return parsed.value;
    },

    async receipts(spacecraftId, batchIds): Promise<BatchResponse[]> {
      if (batchIds.length === 0) return [];
      const { data, error } = await client
        .from("uplink_batches")
        .select("batch_id, results")
        .eq("spacecraft_id", spacecraftId)
        .in("batch_id", batchIds)
        .not("completed_at", "is", null);
      if (error) throw new Error(`uplink_batches: ${error.message}`);

      const receipts: BatchResponse[] = [];
      for (const row of data) {
        const parsed = parseBatchResponse({ batch_id: row.batch_id, duplicate: true, results: row.results });
        if (!parsed.ok) throw new Error(`stored receipt ${row.batch_id} is ${parsed.error}`);
        receipts.push(parsed.value);
      }
      return receipts;
    },
  };
}

export interface RecentBatch {
  batch_id: string;
  spacecraft_id: string;
  entry_count: number;
  compressed_bytes: number;
  received_at: string;
  completed_at: string | null;
}

export async function recentBatches(client: EarthClient, limit: number): Promise<RecentBatch[]> {
  const { data, error } = await client
    .from("uplink_batches")
    .select("batch_id, spacecraft_id, entry_count, compressed_bytes, received_at, completed_at")
    .order("received_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return data;
}
