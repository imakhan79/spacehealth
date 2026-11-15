// Shared by the Server Component (first paint) and the client poller.
// Every query respects RLS: crew see their own vitals, oversight sees all.
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import type { LinkStatus, Snapshot } from "./types";
import { METRICS, type ChartedMetric } from "./vital-thresholds";

type Client = SupabaseClient<Database>;

export async function loadSnapshot(client: Client): Promise<Snapshot> {
  const [crew, alerts, vitals, acoustics] = await Promise.all([
    client
      .from("crew_members")
      .select("id, callsign, full_name, role")
      .eq("is_active", true)
      .neq("role", "sensor_gateway")
      .order("callsign"),
    client
      .from("health_alerts")
      .select("*")
      .in("status", ["active", "acknowledged", "overridden"])
      .order("triggered_at", { ascending: false })
      .limit(50),
    client
      .from("crew_telemetry")
      .select("id, crew_member_id, metric, value, unit, recorded_at")
      .order("recorded_at", { ascending: false })
      .limit(600),
    client
      .from("ambient_acoustics")
      .select("id, module_id, laeq_dba, lmax_dba, limit_exceeded, window_start")
      .order("window_start", { ascending: false })
      .limit(48),
  ]);

  for (const result of [crew, alerts, vitals, acoustics]) {
    if (result.error) throw new Error(result.error.message || "station query failed");
  }

  return {
    crew: crew.data ?? [],
    alerts: alerts.data ?? [],
    vitals: vitals.data ?? [],
    acoustics: acoustics.data ?? [],
    fetchedAt: new Date().toISOString(),
  };
}

export type TrendSeries = Record<ChartedMetric, { t: number; v: number }[]>;

/**
 * One crew member's charted vitals since `sinceMs`, ascending. One request per
 * metric keeps each under PostgREST's 1,000-row cap (6 h at 1/min = 360).
 */
export async function loadTrends(client: Client, crewMemberId: string, sinceMs: number): Promise<TrendSeries> {
  const since = new Date(sinceMs).toISOString();
  const results = await Promise.all(
    METRICS.map((m) =>
      client
        .from("crew_telemetry")
        .select("value, recorded_at")
        .eq("crew_member_id", crewMemberId)
        .eq("metric", m.key)
        .is("deleted_at", null)
        .gte("recorded_at", since)
        .order("recorded_at", { ascending: true })
        .limit(1000),
    ),
  );
  const out = {} as TrendSeries;
  METRICS.forEach((m, i) => {
    const r = results[i]!;
    if (r.error) throw new Error(r.error.message || "trend query failed");
    out[m.key] = (r.data ?? []).map((row) => ({ t: Date.parse(row.recorded_at), v: row.value }));
  });
  return out;
}

export interface LinkSummary {
  status: LinkStatus;
  lastContactAt: string | null;
  rttMs: number | null;
  queuedForEarth: number;
  oldestQueuedAt: string | null;
}

export async function loadLinkSummary(client: Client): Promise<LinkSummary> {
  const [link, backlog] = await Promise.all([client.rpc("get_link_status"), client.rpc("get_uplink_backlog")]);
  if (link.error) throw new Error(link.error.message || "link status unavailable");
  if (backlog.error) throw new Error(backlog.error.message || "backlog unavailable");

  const row = link.data[0];
  const queued = backlog.data.find((b) => b.sync_status === "queued_for_earth");
  return {
    status: row?.status ?? "local_mode",
    lastContactAt: row?.last_contact_at ?? null,
    rttMs: row?.rtt_ms ?? null,
    queuedForEarth: backlog.data.reduce((n, b) => n + (b.sync_status === "conflict" ? 0 : b.entries), 0),
    oldestQueuedAt: queued?.oldest_enqueued_at ?? null,
  };
}
