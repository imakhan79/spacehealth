"use client";

import { Moon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useConnectivity } from "@/components/connectivity-provider";
import type { Me } from "@/lib/dashboard/types";
import { SLEEP_NEED_H, SLEEP_WINDOW, fatigueOutlook, summarizeSleep, type FatigueRisk, type SleepPeriod } from "@/lib/sleep";
import { useNow } from "@/lib/use-now";
import type { Tables } from "@/types/database.types";
import { cn } from "@/lib/utils";
import { outageNotice, readPageCache, savePageCache } from "@/lib/offline/page-cache";

const H = 3_600_000;
const D = 24 * H;
const REFRESH_MS = 60_000;
const RISK: Record<FatigueRisk, { variant: "ok" | "caution" | "warning"; text: string }> = {
  low: { variant: "ok", text: "Low fatigue risk" },
  moderate: { variant: "caution", text: "Moderate fatigue risk" },
  high: { variant: "warning", text: "High fatigue risk" },
};

/** The next 08:00 UTC shift start after `now`. */
function nextShift(now: number): number {
  const d = new Date(now);
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8);
  return at > now ? at : at + D;
}

function WeekChart({ periods, now }: { periods: SleepPeriod[]; now: number }) {
  const today = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate());
  const days = Array.from({ length: 7 }, (_, i) => today - (6 - i) * D);
  const pct = (ms: number) => `${(ms / D) * 100}%`;
  return (
    <div className="flex flex-col gap-1" role="img" aria-label="Sleep periods over the last 7 days on a 24-hour UTC axis">
      {days.map((day) => {
        const bars = periods
          .map((p) => ({ from: Math.max(p.start, day), to: Math.min(p.end, day + D), p }))
          .filter((b) => b.to > b.from);
        return (
          <div key={day} className="flex items-center gap-2">
            <span className="w-12 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">{new Date(day).toISOString().slice(5, 10)}</span>
            <div className="relative h-5 flex-1 overflow-hidden rounded bg-muted/40">
              {/* Lights-off window 22:00–06:00 UTC, split across midnight. */}
              <span className="absolute inset-y-0 left-0 bg-info/10" style={{ width: pct(SLEEP_WINDOW.to * H) }} />
              <span className="absolute inset-y-0 bg-info/10" style={{ left: pct(SLEEP_WINDOW.from * H), right: 0 }} />
              {bars.map((b, i) => (
                <span
                  key={i}
                  tabIndex={0}
                  title={`${new Date(b.p.start).toISOString().slice(11, 16)}–${new Date(b.p.end).toISOString().slice(11, 16)}Z · ${((b.p.end - b.p.start) / H).toFixed(1)} h${b.p.quality ? ` · quality ${b.p.quality}/5` : ""}`}
                  className="absolute inset-y-0.5 rounded-sm bg-series outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  style={{ left: pct(b.from - day), width: pct(b.to - b.from) }}
                />
              ))}
            </div>
          </div>
        );
      })}
      <div className="ml-14 flex justify-between text-[10px] tabular-nums text-muted-foreground">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h}>{String(h).padStart(2, "0")}:00</span>
        ))}
      </div>
      <p className="ml-14 mt-1 text-[11px] text-muted-foreground">
        <span className="mr-1 inline-block size-2.5 rounded-sm bg-series align-middle" aria-hidden /> asleep
        <span className="ml-3 mr-1 inline-block size-2.5 rounded-sm bg-info/20 align-middle" aria-hidden /> lights-off window ({SLEEP_WINDOW.from}:00–0{SLEEP_WINDOW.to}:00 UTC)
      </p>
    </div>
  );
}

export function SleepClient({ me }: { me: Me | null }) {
  const { client } = useConnectivity();
  const now = useNow();
  const [crew, setCrew] = useState<Pick<Tables<"crew_members">, "id" | "callsign" | "full_name">[]>([]);
  const [periods, setPeriods] = useState<Tables<"sleep_periods">[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ start: "", end: "", quality: 3 });
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const [c, p] = await Promise.all([
      client.from("crew_members").select("id, callsign, full_name").eq("is_active", true).neq("role", "sensor_gateway").order("callsign"),
      client.from("sleep_periods").select("*").gte("ended_at", new Date(Date.now() - 8 * D).toISOString()).order("started_at"),
    ]);
    if (c.error || p.error) {
      const cached = readPageCache<{ crew: typeof crew; periods: Tables<"sleep_periods">[] }>("sleep");
      if (cached) {
        setCrew((x) => (x.length ? x : cached.data.crew));
        setPeriods((x) => x ?? cached.data.periods);
      }
      setError(outageNotice(cached?.at ?? null));
      return;
    }
    setError(null);
    setCrew(c.data ?? []);
    setPeriods(p.data ?? []);
    savePageCache("sleep", { crew: c.data ?? [], periods: p.data ?? [] });
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function logSleep(): Promise<void> {
    if (client === null || !form.start || !form.end) return;
    // datetime-local values are entered as UTC (ship time).
    const res = await client.from("sleep_periods").insert({ started_at: `${form.start}:00Z`, ended_at: `${form.end}:00Z`, quality: form.quality });
    setStatus(res.error ? `Couldn't log: ${res.error.message}` : "Sleep logged.");
    await load();
  }

  const visible = crew.filter((c) => (periods ?? []).some((p) => p.crew_member_id === c.id));

  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Moon className="size-6 text-info" aria-hidden /> Sleep & circadian
      </h1>
      <p className="text-sm text-muted-foreground">
        Target {SLEEP_NEED_H} h a night inside the lights-off window. Fatigue outlook is for the next 08:00 UTC shift: a simple model that lists its reasons,
        not a validated fatigue score.
      </p>
      {error && <p className="text-sm text-caution">{error}</p>}
      {periods === null || now === null ? (
        !error && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {visible.map((c) => {
            const mine: SleepPeriod[] = periods
              .filter((p) => p.crew_member_id === c.id)
              .map((p) => ({ start: Date.parse(p.started_at), end: Date.parse(p.ended_at), quality: p.quality }));
            const s = summarizeSleep(mine, now);
            const shift = nextShift(now);
            const f = fatigueOutlook(s, shift, now);
            return (
              <Card key={c.id} className={cn(f.risk === "high" && "border-warning/50", f.risk === "moderate" && "border-caution/40")}>
                <CardContent className="flex flex-col gap-4 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">
                      {c.callsign} <span className="font-normal text-muted-foreground">{c.full_name}</span>
                    </span>
                    <Badge variant={RISK[f.risk].variant}>{RISK[f.risk].text}</Badge>
                  </div>
                  <dl className="grid grid-cols-3 gap-2 text-center">
                    {[
                      ["Last 24 h", `${s.last24h.toFixed(1)} h`, s.last24h < 6],
                      ["7-day average", `${s.avg7d.toFixed(1)} h`, s.avg7d < 7],
                      ["Sleep debt (7 d)", `${s.debt7d.toFixed(0)} h`, s.debt7d >= 5],
                    ].map(([label, value, low]) => (
                      <div key={String(label)} className="rounded-lg bg-muted/50 px-2 py-2">
                        <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
                        <dd className={cn("text-xl font-semibold tabular-nums", low ? "text-caution" : "text-foreground")}>{value}</dd>
                      </div>
                    ))}
                  </dl>
                  {f.reasons.length > 0 && (
                    <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                      {f.reasons.map((r) => (
                        <li key={r}>• {r}</li>
                      ))}
                    </ul>
                  )}
                  <WeekChart periods={mine} now={now} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {me?.crewMemberId && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <p className="w-full text-sm font-semibold">Log a sleep period (UTC)</p>
            <label className="flex flex-col gap-1 text-sm">
              Fell asleep
              <input type="datetime-local" value={form.start} onChange={(e) => setForm((f) => ({ ...f, start: e.target.value }))} className="h-9 rounded-md border border-border bg-background px-2" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Woke up
              <input type="datetime-local" value={form.end} onChange={(e) => setForm((f) => ({ ...f, end: e.target.value }))} className="h-9 rounded-md border border-border bg-background px-2" />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Quality
              <select value={form.quality} onChange={(e) => setForm((f) => ({ ...f, quality: Number(e.target.value) }))} className="h-9 rounded-md border border-border bg-background px-2">
                {[1, 2, 3, 4, 5].map((q) => (
                  <option key={q} value={q}>
                    {q}/5
                  </option>
                ))}
              </select>
            </label>
            <Button onClick={() => void logSleep()} disabled={!form.start || !form.end}>
              Log sleep
            </Button>
            {status && <span role="status" className="text-sm text-muted-foreground">{status}</span>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
