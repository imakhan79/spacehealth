import { HeartPulse, TrendingDown, TrendingUp } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CrewMember, Vital } from "@/lib/dashboard/types";
import { forecast, type Forecast } from "@/lib/dashboard/forecast";
import { METRICS, toneOf, type Tone } from "@/lib/dashboard/vital-thresholds";
import { cn, timeAgo } from "@/lib/utils";

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

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / span) * 24).toFixed(1)}`)
    .join(" ");
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full text-info" aria-hidden>
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
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
  const now = Date.now();

  return (
    <section aria-labelledby="vitals-heading" className="flex flex-col gap-3">
      <h2 id="vitals-heading" className="text-lg font-semibold">
        Crew vitals
      </h2>
      {shown.length === 0 ? (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">No vitals received yet.</CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {shown.map((member) => {
            const samples = byMember.get(member.id) ?? [];
            const latest = samples[0];
            const stale = latest ? now - Date.parse(latest.recorded_at) > STALE_MS : true;
            const hr = samples.filter((s) => s.metric === "heart_rate").slice(0, 30).reverse().map((s) => s.value);
            return (
              <Card key={member.id}>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <HeartPulse className="size-4 text-info" aria-hidden />
                    {member.callsign}
                  </CardTitle>
                  <span className={cn("text-xs", stale ? "text-caution" : "text-muted-foreground")}>
                    {latest ? `${stale ? "No new data · " : ""}${timeAgo(latest.recorded_at, now)}` : "no data"}
                  </span>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                    {METRICS.map((m) => {
                      const sample = samples.find((s) => s.metric === m.key);
                      const tone = sample ? toneOf(m, sample.value) : "normal";
                      return (
                        <div key={m.key}>
                          <dt className="text-xs text-muted-foreground">{m.label}</dt>
                          <dd className={cn("text-xl font-semibold tabular-nums", TONE_CLASS[tone])}>
                            {sample ? sample.value.toFixed(m.digits) : "—"}
                            {sample && <span className="ml-1 text-xs font-normal text-muted-foreground">{sample.unit}</span>}
                          </dd>
                        </div>
                      );
                    })}
                  </dl>
                  <Sparkline values={hr} />
                  <EarlyWarnings items={stale ? [] : forecastsFor(samples, now)} />
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
