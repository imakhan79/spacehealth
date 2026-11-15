"use client";

import { LineChart } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { TrendChart } from "@/components/trend-chart";
import { useConnectivity } from "@/components/connectivity-provider";
import { loadTrends, type TrendSeries } from "@/lib/dashboard/queries";
import type { CrewMember, Me, Vital } from "@/lib/dashboard/types";
import { METRICS, isChartedMetric } from "@/lib/dashboard/vital-thresholds";
import { cn } from "@/lib/utils";

const RANGES = [
  { key: "1h", label: "Last hour", ms: 3_600_000 },
  { key: "6h", label: "Last 6 hours", ms: 6 * 3_600_000 },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

const REFRESH_MS = 30_000;

/** Offline fallback: whatever the dashboard snapshot already holds for this member. */
function fromSnapshot(vitals: Vital[], memberId: string, sinceMs: number): TrendSeries {
  const out = Object.fromEntries(METRICS.map((m) => [m.key, [] as { t: number; v: number }[]])) as TrendSeries;
  for (const v of vitals) {
    const t = Date.parse(v.recorded_at);
    if (v.crew_member_id === memberId && t >= sinceMs && isChartedMetric(v.metric)) out[v.metric].push({ t, v: v.value });
  }
  for (const m of METRICS) out[m.key].sort((a, b) => a.t - b.t);
  return out;
}

export function VitalTrends({ crew, vitals, me }: { crew: CrewMember[]; vitals: Vital[]; me: Me | null }) {
  const { client } = useConnectivity();
  // RLS limits crew to their own vitals, so only offer members we have data for.
  const members = useMemo(() => crew.filter((c) => vitals.some((v) => v.crew_member_id === c.id)), [crew, vitals]);
  const [memberId, setMemberId] = useState<string | null>(null);
  const [range, setRange] = useState<RangeKey>("1h");
  const [series, setSeries] = useState<TrendSeries | null>(null);
  const [loading, setLoading] = useState(false);
  const [offline, setOffline] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const selected = memberId ?? members.find((m) => m.id === me?.crewMemberId)?.id ?? members[0]?.id ?? null;
  const rangeMs = RANGES.find((r) => r.key === range)!.ms;

  const load = useCallback(async (): Promise<void> => {
    if (client === null || selected === null) return;
    const at = Date.now();
    setLoading(true);
    try {
      setSeries(await loadTrends(client, selected, at - rangeMs));
      setOffline(false);
    } catch {
      setSeries(fromSnapshot(vitals, selected, at - rangeMs));
      setOffline(true);
    } finally {
      setNow(at);
      setLoading(false);
    }
  }, [client, selected, rangeMs, vitals]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const tableRows = useMemo(() => {
    if (!series) return [];
    const byTime = new Map<number, Partial<Record<(typeof METRICS)[number]["key"], number>>>();
    for (const m of METRICS) for (const p of series[m.key]) byTime.set(p.t, { ...byTime.get(p.t), [m.key]: p.v });
    return [...byTime.entries()].sort((a, b) => b[0] - a[0]);
  }, [series]);

  if (members.length === 0) return null;

  return (
    <section aria-labelledby="trends-heading" className="flex flex-col gap-3">
      <h2 id="trends-heading" className="flex items-center gap-2 text-lg font-semibold">
        <LineChart className="size-4 text-info" aria-hidden />
        Vital trends
      </h2>

      {/* One row of controls above the charts; they scope every chart and the table. */}
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Crew</span>
          <select
            value={selected ?? ""}
            onChange={(e) => setMemberId(e.target.value)}
            className="h-9 rounded-md border border-border bg-background px-2 text-sm"
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {m.callsign} · {m.full_name}
              </option>
            ))}
          </select>
        </label>
        <div role="radiogroup" aria-label="Time range" className="flex rounded-md border border-border p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.key}
              role="radio"
              aria-checked={range === r.key}
              onClick={() => setRange(r.key)}
              className={cn(
                "h-8 rounded px-3 text-sm",
                range === r.key ? "bg-muted font-semibold text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {r.label}
            </button>
          ))}
        </div>
        <span className="flex items-center gap-3 text-xs text-muted-foreground" aria-label="Chart key">
          <span className="flex items-center gap-1">
            <span className="inline-block size-3 rounded-sm bg-caution/25" aria-hidden /> Caution range
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block size-3 rounded-sm bg-emergency/25" aria-hidden /> Emergency range
          </span>
        </span>
      </div>

      {offline && (
        <p className="text-sm text-caution">Station server not responding. Showing the samples cached with the dashboard.</p>
      )}

      <Card>
        {/* Refetch keeps the previous render, dimmed, instead of flashing empty. */}
        <CardContent className={cn("grid gap-4 p-4 sm:grid-cols-2", loading && series && "opacity-60")}>
          {METRICS.map((spec) => (
            <TrendChart key={spec.key} spec={spec} points={series?.[spec.key] ?? []} from={now - rangeMs} to={now} />
          ))}
        </CardContent>
      </Card>

      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Show samples as a table ({tableRows.length})</summary>
        <div className="mt-2 max-h-72 overflow-auto rounded-md border border-border">
          <table className="w-full text-left tabular-nums">
            <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Time</th>
                {METRICS.map((m) => (
                  <th key={m.key} className="px-3 py-2 font-medium">
                    {m.label} ({m.unit})
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {tableRows.map(([t, row]) => (
                <tr key={t} className="border-t border-border">
                  <td className="px-3 py-1.5 text-muted-foreground">{new Date(t).toISOString().slice(11, 16)}Z</td>
                  {METRICS.map((m) => (
                    <td key={m.key} className="px-3 py-1.5">
                      {row[m.key] === undefined ? "—" : row[m.key]!.toFixed(m.digits)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
