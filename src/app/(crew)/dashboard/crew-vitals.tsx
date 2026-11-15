import { HeartPulse } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CrewMember, Vital } from "@/lib/dashboard/types";
import { METRICS, toneOf, type Tone } from "@/lib/dashboard/vital-thresholds";
import { cn, timeAgo } from "@/lib/utils";

const STALE_MS = 5 * 60_000;

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
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </section>
  );
}
