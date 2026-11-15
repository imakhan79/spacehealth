"use client";

import { Droplets, Plus, Utensils } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConnectivity } from "@/components/connectivity-provider";
import type { Me } from "@/lib/dashboard/types";
import { CATALOG, NUTRIENT_LABEL, TARGETS, behind, totals, type CatalogItem, type Nutrients } from "@/lib/nutrition";
import { useNow } from "@/lib/use-now";
import type { Tables } from "@/types/database.types";
import { cn } from "@/lib/utils";
import { outageNotice, readPageCache, savePageCache } from "@/lib/offline/page-cache";
import { HowTo } from "@/components/how-to";

type Log = Tables<"intake_logs">;
const KEYS = Object.keys(TARGETS) as (keyof Nutrients)[];
const REFRESH_MS = 30_000;

function Meter({ k, value, flagged }: { k: keyof Nutrients; value: number; flagged: boolean }) {
  const { label, unit } = NUTRIENT_LABEL[k];
  const share = value / TARGETS[k];
  const met = share >= 1;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          <span className={cn("font-semibold", met ? "text-ok" : flagged ? "text-caution" : "text-foreground")}>{Math.round(value).toLocaleString("en-US")}</span> /{" "}
          {TARGETS[k].toLocaleString("en-US")} {unit}
        </span>
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={TARGETS[k]}
        aria-valuenow={Math.round(value)}
        className={cn("h-2 overflow-hidden rounded-full", met ? "bg-ok/20" : flagged ? "bg-caution/20" : "bg-series/20")}
      >
        <div className={cn("h-full rounded-full", met ? "bg-ok" : flagged ? "bg-caution" : "bg-series")} style={{ width: `${Math.min(100, share * 100)}%` }} />
      </div>
      {flagged && <span className="text-xs text-caution">Behind pace for this time of day</span>}
    </div>
  );
}

export function NutritionClient({ me }: { me: Me | null }) {
  const { client } = useConnectivity();
  const now = useNow();
  const [crew, setCrew] = useState<Pick<Tables<"crew_members">, "id" | "callsign">[]>([]);
  const [logs, setLogs] = useState<Log[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const d = new Date();
    const midnight = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
    const [c, l] = await Promise.all([
      client.from("crew_members").select("id, callsign").eq("is_active", true).neq("role", "sensor_gateway").order("callsign"),
      client.from("intake_logs").select("*").gte("logged_at", midnight).order("logged_at", { ascending: false }),
    ]);
    if (c.error || l.error) {
      const cached = readPageCache<{ crew: typeof crew; logs: Log[] }>("nutrition");
      if (cached) {
        setCrew((x) => (x.length ? x : cached.data.crew));
        setLogs((x) => x ?? cached.data.logs);
      }
      setError(outageNotice(cached?.at ?? null));
      return;
    }
    setError(null);
    setCrew(c.data ?? []);
    setLogs(l.data ?? []);
    savePageCache("nutrition", { crew: c.data ?? [], logs: l.data ?? [] });
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function add(item: CatalogItem): Promise<void> {
    if (client === null) return;
    setBusy(item.id);
    const { id: _id, label, kind, ...n } = item;
    const res = await client.from("intake_logs").insert({ label, kind, ...n });
    if (res.error) setError(`Couldn't log: ${res.error.message}`);
    await load();
    setBusy(null);
  }

  const hour = now === null ? 0 : new Date(now).getUTCHours();
  const mine = (logs ?? []).filter((l) => l.crew_member_id === me?.crewMemberId);
  const myTotals = totals(mine);
  const myBehind = new Set(behind(myTotals, hour));
  const oversight = me?.role === "flight_surgeon" || me?.role === "commander";

  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Utensils className="size-6 text-info" aria-hidden /> Nutrition & hydration
      </h1>
      <HowTo page="nutrition" />
      <p className="text-sm text-muted-foreground">
        Daily targets (UTC day). Calcium, vitamin D and protein help protect bone and muscle in microgravity; thirst is blunted in space, so water is easy
        to miss.
      </p>
      {error && <p className="text-sm text-caution">{error}</p>}

      {me?.crewMemberId && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Today, you</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              {KEYS.map((k) => (
                <Meter key={k} k={k} value={myTotals[k]} flagged={myBehind.has(k)} />
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Quick add</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap gap-2">
                {CATALOG.filter((c) => c.kind === "water").map((c) => (
                  <button
                    key={c.id}
                    disabled={busy !== null}
                    onClick={() => void add(c)}
                    className="flex items-center gap-1.5 rounded-lg border border-info/40 bg-info/10 px-3 py-2 text-sm text-info hover:bg-info/20 disabled:opacity-50"
                  >
                    <Droplets className="size-4" aria-hidden /> {c.label}
                  </button>
                ))}
              </div>
              <ul className="grid gap-2 sm:grid-cols-2">
                {CATALOG.filter((c) => c.kind === "meal").map((c) => (
                  <li key={c.id}>
                    <button
                      disabled={busy !== null}
                      onClick={() => void add(c)}
                      className="flex w-full items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-left hover:bg-muted disabled:opacity-50"
                    >
                      <Plus className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{c.label}</span>
                        <span className="block text-xs text-muted-foreground tabular-nums">
                          {c.kcal} kcal · {c.protein_g} g protein · {c.calcium_mg} mg Ca{c.vitamin_d_iu ? ` · ${c.vitamin_d_iu} IU D` : ""}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {mine.length > 0 && (
                <details className="text-sm">
                  <summary className="cursor-pointer text-muted-foreground">Logged today ({mine.length})</summary>
                  <ul className="mt-2 flex flex-col gap-1">
                    {mine.map((l) => (
                      <li key={l.id} className="flex gap-3 tabular-nums">
                        <span className="text-muted-foreground">{new Date(l.logged_at).toISOString().slice(11, 16)}Z</span>
                        <span>{l.label}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {oversight && logs !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Crew today (share of target)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left text-sm tabular-nums">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Crew</th>
                  {KEYS.map((k) => (
                    <th key={k} className="py-1 pr-3 font-medium">
                      {NUTRIENT_LABEL[k].label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {crew.map((c) => {
                  const t = totals(logs.filter((l) => l.crew_member_id === c.id));
                  const b = new Set(behind(t, hour));
                  return (
                    <tr key={c.id} className="border-t border-border">
                      <td className="py-1.5 pr-3 font-semibold">{c.callsign}</td>
                      {KEYS.map((k) => (
                        <td key={k} className={cn("py-1.5 pr-3", b.has(k) && "font-semibold text-caution")}>
                          {Math.round((t[k] / TARGETS[k]) * 100)}%{b.has(k) && " ↓"}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="mt-2 text-xs text-muted-foreground">↓ = behind pace for this time of day (checked after 11:00 UTC).</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
