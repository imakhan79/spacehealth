"use client";

import { Gauge, OctagonAlert, Orbit, Timer, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useConnectivity } from "@/components/connectivity-provider";
import type { Me } from "@/lib/dashboard/types";
import { CONSUMABLE_LABEL, PREBREATHE_MINUTES, SUIT, assessSuit, minutesLeft, type Consumable, type SuitSample, type Tone } from "@/lib/eva";
import { outageNotice, readPageCache, savePageCache } from "@/lib/offline/page-cache";
import type { Tables } from "@/types/database.types";
import { cn } from "@/lib/utils";
import { HowTo } from "@/components/how-to";

type Session = Tables<"eva_sessions">;
type Row = Tables<"suit_telemetry">;
interface EvaData {
  session: Session | null;
  rows: Row[];
  crew: { id: string; callsign: string }[];
  past: Session[];
}

const REFRESH_MS = 10_000;
const TONE_STYLE: Record<Tone, { card: string; badge: "ok" | "caution" | "emergency"; label: string }> = {
  normal: { card: "", badge: "ok", label: "Nominal" },
  caution: { card: "border-caution/50", badge: "caution", label: "Caution" },
  emergency: { card: "border-emergency/70", badge: "emergency", label: "Emergency" },
};
const FIELD: Record<Consumable, keyof SuitSample> = { o2: "o2_pct", battery: "battery_pct", feedwater: "feedwater_pct", scrubber: "scrubber_pct" };

const hm = (min: number) => `${Math.floor(min / 60)} h ${String(Math.floor(min % 60)).padStart(2, "0")} min`;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

function PressureTrend({ samples }: { samples: SuitSample[] }) {
  if (samples.length < 2) return null;
  const W = 300;
  const H = 56;
  const lo = Math.min(SUIT.pressureCautionKpa - 0.4, ...samples.map((s) => s.suit_pressure_kpa));
  const hi = SUIT.pressureNominalKpa + 0.3;
  const t0 = samples[0]!.t;
  const t1 = samples.at(-1)!.t;
  const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * W;
  const y = (v: number) => H - ((v - lo) / (hi - lo)) * H;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-14 w-full" role="img" aria-label={`Suit pressure over the last ${Math.round((t1 - t0) / 60_000)} minutes, latest ${samples.at(-1)!.suit_pressure_kpa.toFixed(2)} kPa`}>
      <rect x={0} y={y(SUIT.pressureCautionKpa)} width={W} height={H - y(SUIT.pressureCautionKpa)} fill="var(--color-caution)" opacity={0.12} />
      <polyline
        points={samples.map((s) => `${x(s.t).toFixed(1)},${y(s.suit_pressure_kpa).toFixed(1)}`).join(" ")}
        fill="none"
        stroke="var(--color-series)"
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function SuitCard({ callsign, role, samples, stale }: { callsign: string; role: "EV1" | "EV2"; samples: SuitSample[]; stale: boolean }) {
  const a = assessSuit(samples);
  const latest = samples.at(-1);
  if (!a || !latest) {
    return (
      <Card>
        <CardContent className="p-4 text-sm text-muted-foreground">
          {role} {callsign}: no suit telemetry yet.
        </CardContent>
      </Card>
    );
  }
  const st = TONE_STYLE[a.tone];
  const recent = samples.filter((s) => s.t > latest.t - 20 * 60_000);
  return (
    <Card className={cn(st.card)}>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-md bg-info/15 px-2 py-0.5 text-xs font-bold text-info">{role}</span>
          <span className="text-lg font-semibold">{callsign}</span>
          <Badge variant={st.badge} className="ml-auto">
            {st.label}
          </Badge>
        </div>

        <div className="rounded-lg bg-muted/50 p-3">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">EVA time remaining{stale && " (last known)"}</p>
          <p className={cn("text-3xl font-semibold tabular-nums", a.limiting && a.limiting.minutes < SUIT.returnMinutes ? "text-caution" : "text-foreground")}>
            {a.limiting ? hm(a.limiting.minutes) : "—"}
          </p>
          <p className="text-xs text-muted-foreground">{a.limiting ? `Limited by ${CONSUMABLE_LABEL[a.limiting.consumable].toLowerCase()}, keeping a ${SUIT.reservePct}% reserve` : "No consumable draining"}</p>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          {(Object.keys(FIELD) as Consumable[]).map((c) => {
            const pct = latest[FIELD[c]];
            const m = minutesLeft(recent, c);
            const limiting = a.limiting?.consumable === c;
            return (
              <div key={c} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between text-sm">
                  <span className={cn(limiting && "font-semibold")}>{CONSUMABLE_LABEL[c]}</span>
                  <span className="tabular-nums text-muted-foreground">
                    <span className="font-semibold text-foreground">{Math.round(pct)}%</span> · {m === null ? "steady" : hm(m)}
                  </span>
                </div>
                <div role="meter" aria-label={CONSUMABLE_LABEL[c]} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} className="relative h-2 overflow-hidden rounded-full bg-series/20">
                  <div className={cn("h-full rounded-full", limiting ? "bg-info" : "bg-series")} style={{ width: `${pct}%` }} />
                  <span className="absolute inset-y-0 w-px bg-foreground/60" style={{ left: `${SUIT.reservePct}%` }} aria-hidden />
                </div>
              </div>
            );
          })}
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          {[
            ["Suit pressure", `${latest.suit_pressure_kpa.toFixed(2)}`, "kPa", latest.suit_pressure_kpa < SUIT.pressureCautionKpa],
            ["CO₂", latest.co2_mmhg.toFixed(1), "mmHg", latest.co2_mmhg > SUIT.co2CautionMmhg],
            ["Heart rate", String(Math.round(latest.heart_rate)), "bpm", latest.heart_rate > SUIT.hrCaution],
          ].map(([label, value, unit, bad]) => (
            <div key={String(label)} className={cn("rounded-lg bg-muted/50 px-2 py-2", bad && "bg-caution/15")}>
              <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
              <p className={cn("text-xl font-semibold tabular-nums", bad ? "text-caution" : "text-foreground")}>
                {value} <span className="text-xs font-normal text-muted-foreground">{unit}</span>
              </p>
            </div>
          ))}
        </div>

        <div>
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Suit pressure, last 60 min (shaded: below {SUIT.pressureCautionKpa} kPa)</p>
          <PressureTrend samples={samples} />
        </div>

        {a.cues.length > 0 && (
          <ul className="flex flex-col gap-1.5">
            {a.cues.map((c) => {
              const Icon = c.tone === "emergency" ? OctagonAlert : TriangleAlert;
              return (
                <li
                  key={c.text}
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-3 py-2 text-sm font-medium",
                    c.tone === "emergency" ? "border-emergency/60 bg-emergency/15 text-emergency" : "border-caution/50 bg-caution/10 text-caution",
                  )}
                >
                  <Icon className="mt-0.5 size-4 shrink-0" aria-hidden /> {c.text}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

export function EvaClient({ me }: { me: Me | null }) {
  const { client } = useConnectivity();
  const [data, setData] = useState<EvaData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const [sessions, crew] = await Promise.all([
      client.from("eva_sessions").select("*").order("prebreathe_start", { ascending: false }).limit(6),
      client.from("crew_members").select("id, callsign"),
    ]);
    const all = sessions.data ?? [];
    const current = all.find((s) => s.status === "prebreathe" || s.status === "eva" || s.status === "planned") ?? all[0] ?? null;
    const rows = current
      ? await client.from("suit_telemetry").select("*").eq("session_id", current.id).gte("recorded_at", new Date(Date.now() - 60 * 60_000).toISOString()).order("recorded_at").limit(400)
      : { data: [], error: null };
    if (sessions.error || crew.error || rows.error) {
      const cached = readPageCache<EvaData>("eva");
      setData((d) => d ?? cached?.data ?? null);
      setError(outageNotice(cached?.at ?? null));
      return;
    }
    const fresh: EvaData = { session: current, rows: rows.data ?? [], crew: crew.data ?? [], past: all.filter((s) => s !== current) };
    setError(null);
    setData(fresh);
    savePageCache("eva", fresh);
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function terminate(): Promise<void> {
    if (client === null || !data?.session) return;
    const res = await client.from("eva_sessions").update({ status: "aborted", end_reason: reason.trim() || "Terminated by IV operator" }).eq("id", data.session.id);
    setMsg(res.error ? `Couldn't terminate: ${res.error.message}` : "EVA terminated. Crew returning to the airlock.");
    setConfirming(false);
    await load();
  }

  const s = data?.session ?? null;
  const callsign = (id: string) => data?.crew.find((c) => c.id === id)?.callsign ?? "crew";
  const toSample = (r: Row): SuitSample => ({ t: Date.parse(r.recorded_at), ...r });
  const live = s && (s.status === "prebreathe" || s.status === "eva");
  const egress = s ? Date.parse(s.egress_at) : 0;
  const inPrebreathe = s !== null && now !== null && live && now < egress;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Orbit className="size-6 text-info" aria-hidden /> EVA monitor
      </h1>
      <HowTo page="eva" />
      <p className="text-sm text-muted-foreground">
        Spacewalk suit telemetry for the intravehicular operator. Limits are demo-grade, modelled on the US EMU suit (about {SUIT.pressureNominalKpa} kPa); a real
        mission uses its own flight rules.
      </p>
      {error && <p className="text-sm text-caution">{error}</p>}
      {msg && <p role="status" className="text-sm text-info">{msg}</p>}

      {data === null || now === null ? (
        !error && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : s === null ? (
        <p className="text-sm text-muted-foreground">No EVA planned.</p>
      ) : (
        <>
          <Card className={cn(live && "border-info/50")}>
            <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-3 p-4">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Objective</p>
                <p className="font-semibold">{s.objective}</p>
                <p className="text-xs text-muted-foreground">
                  EV1 {callsign(s.ev1)} · EV2 {callsign(s.ev2)}
                </p>
              </div>
              {inPrebreathe ? (
                <div className="flex items-center gap-3">
                  <Timer className="size-8 text-info" aria-hidden />
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Prebreathe · egress in</p>
                    <p className="text-3xl font-semibold tabular-nums">{mmss(egress - now)}</p>
                    <p className="text-xs text-muted-foreground">{PREBREATHE_MINUTES} min of pure O₂ to purge nitrogen and prevent decompression sickness</p>
                  </div>
                </div>
              ) : live ? (
                <div className="flex min-w-60 flex-1 items-center gap-3">
                  <Gauge className="size-8 text-info" aria-hidden />
                  <div className="flex-1">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">EVA elapsed · planned {hm(s.planned_minutes)}</p>
                    <p className="text-3xl font-semibold tabular-nums">{mmss(now - egress)}</p>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-series/20">
                      <div className="h-full rounded-full bg-series" style={{ width: `${Math.min(100, ((now - egress) / (s.planned_minutes * 60_000)) * 100)}%` }} />
                    </div>
                  </div>
                </div>
              ) : (
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Status</p>
                  <p className="font-semibold">
                    {s.status === "aborted" ? "Terminated" : s.status === "complete" ? "Complete" : "Planned"}
                    {s.ended_at && ` at ${new Date(s.ended_at).toISOString().slice(11, 16)}Z`}
                    {s.ended_by && ` by ${callsign(s.ended_by)}`}
                  </p>
                  {s.end_reason && <p className="text-xs text-muted-foreground">{s.end_reason}</p>}
                </div>
              )}
              {live && me?.role === "commander" && (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {confirming ? (
                    <>
                      <input
                        value={reason}
                        onChange={(e) => setReason(e.target.value)}
                        placeholder="Reason (e.g. suit leak)"
                        aria-label="Reason for terminating"
                        className="h-9 w-48 rounded-md border border-border bg-background px-2 text-sm"
                      />
                      <Button variant="destructive" onClick={() => void terminate()}>
                        Confirm terminate
                      </Button>
                      <Button variant="outline" onClick={() => setConfirming(false)}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button variant="destructive" onClick={() => setConfirming(true)}>
                      <OctagonAlert aria-hidden /> Terminate EVA
                    </Button>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {!inPrebreathe && (
            <div className="grid gap-4 xl:grid-cols-2">
              {([["EV1", s.ev1], ["EV2", s.ev2]] as const).map(([role, id]) => (
                <SuitCard key={id} role={role} callsign={callsign(id)} samples={data.rows.filter((r) => r.crew_member_id === id).map(toSample)} stale={error !== null || !live} />
              ))}
            </div>
          )}

          {data.past.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">Recent EVAs ({data.past.length})</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {data.past.map((p) => (
                  <li key={p.id} className="tabular-nums">
                    <span className="text-muted-foreground">{new Date(p.egress_at).toISOString().slice(5, 16).replace("T", " ")}Z</span> · {p.objective} · {callsign(p.ev1)} &amp;{" "}
                    {callsign(p.ev2)} · {p.status}
                    {p.end_reason && ` (${p.end_reason})`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
