"use client";

import { CircleAlert, CircleCheck, HeartPulse, OctagonAlert, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { CrewMember, Vital } from "@/lib/dashboard/types";
import { forecast, type Forecast } from "@/lib/dashboard/forecast";
import { METRICS, toneOf, type Tone } from "@/lib/dashboard/vital-thresholds";
import { Ago, useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const STALE_MS = 5 * 60_000;

/** Early warnings for one member: normal vitals trending into caution soon. */
function forecastsFor(samples: Vital[], now: number): Forecast[] {
  const out: Forecast[] = [];
  for (const m of METRICS) {
    const series = samples.filter((s) => s.metric === m.key).map((s) => ({ t: Date.parse(s.recorded_at), v: s.value }));
    const f = forecast(m, series, now);
    if (f) out.push(f);
  }
  return out.sort((a, b) => a.minutesToCross - b.minutesToCross);
}

export function EarlyWarnings({ items }: { items: Forecast[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="flex flex-col gap-1" aria-label="Early warnings">
      {items.map((f) => {
        const spec = METRICS.find((m) => m.key === f.metric)!;
        const Icon = f.direction === "rising" ? TrendingUp : TrendingDown;
        return (
          <li key={f.metric} className="flex items-start gap-1.5 rounded-md border border-caution/40 bg-caution/10 px-2 py-1 text-xs text-caution">
            <Icon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>
              {spec.label} {f.direction}, reaches caution ({f.threshold} {spec.unit}) in about {Math.max(1, Math.round(f.minutesToCross))} min
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  normal: "text-foreground",
  caution: "text-caution",
  emergency: "text-emergency",
};

const STATUS: Record<Tone, { label: string; pill: string; ring: string; icon: typeof CircleCheck }> = {
  normal: { label: "Nominal", pill: "border-ok/40 bg-ok/10 text-ok", ring: "ring-ok/60", icon: CircleCheck },
  caution: { label: "Caution", pill: "border-caution/50 bg-caution/10 text-caution", ring: "ring-caution/70", icon: CircleAlert },
  emergency: { label: "Emergency", pill: "border-emergency/60 bg-emergency/15 text-emergency", ring: "ring-emergency", icon: OctagonAlert },
};

const ROLE_LABEL: Record<string, string> = { commander: "Commander", flight_surgeon: "Flight surgeon", crew: "Mission specialist", sensor_gateway: "Sensors" };

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * 100, 34 - ((v - min) / span) * 28] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `0,36 ${line} 100,36`;
  return (
    <svg viewBox="0 0 100 36" preserveAspectRatio="none" className="h-10 w-full text-series" aria-hidden>
      <polygon points={area} fill="currentColor" opacity={0.1} />
      <polyline points={line} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function CrewVitals({ crew, vitals }: { crew: CrewMember[]; vitals: Vital[] }) {
  // vitals arrive newest first; RLS already limits crew to their own.
  const byMember = new Map<string, Vital[]>();
  for (const v of vitals) {
    const list = byMember.get(v.crew_member_id) ?? [];
    list.push(v);
    byMember.set(v.crew_member_id, list);
  }
  const shown = crew.filter((c) => byMember.has(c.id));
  // Null until hydrated: staleness and forecasts appear right after first paint.
  const now = useNow();

  return (
    <section aria-labelledby="vitals-heading" className="flex flex-col gap-3">
      <h2 id="vitals-heading" className="flex items-center gap-2 text-lg font-semibold">
        <HeartPulse className="size-4 text-info" aria-hidden /> Crew vitals
      </h2>
      {shown.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">No vitals received yet.</CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((member) => {
            const samples = byMember.get(member.id) ?? [];
            const latest = samples[0];
            const stale = latest ? now !== null && now - Date.parse(latest.recorded_at) > STALE_MS : true;
            const hr = samples.filter((s) => s.metric === "heart_rate").slice(0, 30).reverse().map((s) => s.value);
            const worstTone = METRICS.reduce<Tone>((t, m) => {
              const sample = samples.find((s) => s.metric === m.key);
              const x = sample ? toneOf(m, sample.value) : "normal";
              return t === "emergency" || x === "emergency" ? "emergency" : t === "caution" || x === "caution" ? "caution" : "normal";
            }, "normal");
            const st = STATUS[worstTone];
            const StatusIcon = st.icon;
            return (
              <Card key={member.id} className={cn(worstTone === "emergency" && "border-emergency/60", worstTone === "caution" && "border-caution/40")}>
                <CardContent className="flex flex-col gap-4 p-4">
                  <div className="flex items-center gap-3">
                    <div
                      className={cn(
                        "flex size-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-series/30 to-muted text-sm font-bold ring-2 ring-offset-2 ring-offset-card",
                        st.ring,
                      )}
                      aria-hidden
                    >
                      {member.callsign.slice(0, 3)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold leading-tight">{member.callsign}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {ROLE_LABEL[member.role] ?? member.role} · {latest ? <Ago iso={latest.recorded_at} prefix={stale ? "no new data · " : ""} /> : "no data"}
                      </p>
                    </div>
                    <span className={cn("flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold", st.pill)}>
                      <StatusIcon className="size-3.5" aria-hidden /> {st.label}
                    </span>
                  </div>
                  <dl className="grid grid-cols-2 gap-2">
                    {METRICS.map((m) => {
                      const sample = samples.find((s) => s.metric === m.key);
                      const tone = sample ? toneOf(m, sample.value) : "normal";
                      return (
                        <div key={m.key} className={cn("rounded-lg bg-muted/50 px-3 py-2", tone !== "normal" && (tone === "emergency" ? "bg-emergency/10" : "bg-caution/10"))}>
                          <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{m.label}</dt>
                          <dd className={cn("text-2xl font-semibold tabular-nums leading-tight", TONE_CLASS[tone])}>
                            {sample ? sample.value.toFixed(m.digits) : "—"}
                            {sample && <span className="ml-1 text-xs font-normal text-muted-foreground">{sample.unit}</span>}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Heart rate · last 30 samples</p>
                    <Sparkline values={hr} />
                  </div>
                  <EarlyWarnings items={stale || now === null ? [] : forecastsFor(samples, now)} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
