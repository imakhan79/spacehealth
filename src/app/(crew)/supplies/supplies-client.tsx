"use client";

import { Container } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useConnectivity } from "@/components/connectivity-provider";
import type { Me } from "@/lib/dashboard/types";
import { RESOURCES, RESUPPLY_IN_DAYS, supplyStatus, type Reading, type Resource, type SupplyStatus } from "@/lib/supplies";
import { useNow } from "@/lib/use-now";
import type { Tables } from "@/types/database.types";
import { cn } from "@/lib/utils";
import { outageNotice, readPageCache, savePageCache } from "@/lib/offline/page-cache";
import { HowTo } from "@/components/how-to";

const D = 86_400_000;
const REFRESH_MS = 60_000;
const ORDER: Resource[] = ["oxygen", "water", "food", "co2_cartridges"];
const TONE_BADGE = { normal: "ok", caution: "caution", emergency: "emergency" } as const;
const TONE_WORD = { normal: "On track", caution: "Tight margin", emergency: "Short of resupply" } as const;

function BurnDown({ readings, status, now }: { readings: Reading[]; status: SupplyStatus; now: number }) {
  const W = 520;
  const Hh = 150;
  const pad = { l: 44, r: 12, t: 12, b: 22 };
  const from = now - 30 * D;
  const to = now + 90 * D;
  const maxQ = Math.max(...readings.map((r) => r.q), status.latest) * 1.08 || 1;
  const x = (t: number) => pad.l + ((t - from) / (to - from)) * (W - pad.l - pad.r);
  const y = (q: number) => pad.t + (1 - q / maxQ) * (Hh - pad.t - pad.b);
  const hist = readings.filter((r) => r.t >= from).sort((a, b) => a.t - b.t);
  const path = hist.map((r, i) => `${i ? "L" : "M"}${x(r.t).toFixed(1)},${y(r.q).toFixed(1)}`).join("");
  const last = hist.at(-1);
  const end = status.depletesAt !== null ? Math.min(status.depletesAt, to) : null;
  const endQ = end !== null && last ? Math.max(0, status.latest - ((end - last.t) / D) * (status.perDay ?? 0)) : null;
  const resupply = now + RESUPPLY_IN_DAYS * D;
  const ticks = [0, maxQ / 2, maxQ].map((q) => Math.round(q));
  return (
    <svg viewBox={`0 0 ${W} ${Hh}`} className="h-auto w-full" role="img" aria-label={`Stock over the last 30 days and projected; ${status.daysLeft === null ? "not being consumed" : `runs out in about ${Math.round(status.daysLeft)} days`}; resupply in ${RESUPPLY_IN_DAYS} days.`}>
      {ticks.map((q) => (
        <g key={q}>
          <line x1={pad.l} x2={W - pad.r} y1={y(q)} y2={y(q)} stroke="var(--color-border)" strokeWidth={1} />
          <text x={pad.l - 6} y={y(q)} dy="0.32em" textAnchor="end" fontSize={10} fill="var(--color-muted-foreground)">
            {q.toLocaleString("en-US")}
          </text>
        </g>
      ))}
      {/* Now and resupply markers (labelled; solid hairlines, not dashed). */}
      <line x1={x(now)} x2={x(now)} y1={pad.t} y2={Hh - pad.b} stroke="var(--color-muted-foreground)" strokeWidth={1} opacity={0.6} />
      <text x={x(now)} y={Hh - 6} textAnchor="middle" fontSize={10} fill="var(--color-muted-foreground)">now</text>
      <line x1={x(resupply)} x2={x(resupply)} y1={pad.t} y2={Hh - pad.b} stroke="var(--color-ok)" strokeWidth={1.5} />
      <text x={x(resupply)} y={Hh - 6} textAnchor="middle" fontSize={10} fill="var(--color-ok)">resupply</text>
      <text x={pad.l} y={Hh - 6} fontSize={10} fill="var(--color-muted-foreground)">−30 d</text>
      <text x={W - pad.r} y={Hh - 6} textAnchor="end" fontSize={10} fill="var(--color-muted-foreground)">+90 d</text>
      <path d={path} fill="none" stroke="var(--color-series)" strokeWidth={2} strokeLinejoin="round" />
      {last && end !== null && endQ !== null && (
        <line x1={x(last.t)} y1={y(last.q)} x2={x(end)} y2={y(endQ)} stroke="var(--color-series)" strokeWidth={2} opacity={0.4} />
      )}
      {status.depletesAt !== null && status.depletesAt <= to && (
        <circle cx={x(status.depletesAt)} cy={y(0)} r={4} fill={status.tone === "emergency" ? "var(--color-emergency)" : "var(--color-series)"} stroke="var(--color-card)" strokeWidth={2} />
      )}
    </svg>
  );
}

export function SuppliesClient({ me }: { me: Me | null }) {
  const { client } = useConnectivity();
  const now = useNow();
  const [readings, setReadings] = useState<Tables<"consumable_readings">[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [count, setCount] = useState<{ resource: Resource; quantity: string }>({ resource: "co2_cartridges", quantity: "" });
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const r = await client.from("consumable_readings").select("*").gte("measured_at", new Date(Date.now() - 31 * D).toISOString()).order("measured_at").limit(5000);
    if (r.error) {
      const cached = readPageCache<Tables<"consumable_readings">[]>("supplies");
      setReadings((x) => x ?? cached?.data ?? null);
      setError(outageNotice(cached?.at ?? null));
      return;
    }
    setError(null);
    setReadings(r.data ?? []);
    savePageCache("supplies", r.data ?? []);
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  async function record(): Promise<void> {
    if (client === null || count.quantity === "") return;
    const res = await client.from("consumable_readings").insert({ resource: count.resource, quantity: Number(count.quantity) });
    setStatus(res.error ? `Couldn't record: ${res.error.message}` : "Count recorded.");
    await load();
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Container className="size-6 text-info" aria-hidden /> Life-support supplies
      </h1>
      <HowTo page="supplies" />
      <p className="text-sm text-muted-foreground">
        Usage is fitted over the last 7 days; days left assume that rate continues. Next resupply arrives in {RESUPPLY_IN_DAYS} days; stock should outlast it
        by at least two weeks.
      </p>
      {error && <p className="text-sm text-caution">{error}</p>}
      {readings === null || now === null ? (
        !error && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {ORDER.map((res) => {
            const rs: Reading[] = readings.filter((r) => r.resource === res).map((r) => ({ t: Date.parse(r.measured_at), q: r.quantity }));
            const s = supplyStatus(rs, now);
            const meta = RESOURCES[res];
            return (
              <Card key={res} className={cn(s?.tone === "emergency" && "border-emergency/60", s?.tone === "caution" && "border-caution/50")}>
                <CardContent className="flex flex-col gap-3 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-semibold">{meta.label}</span>
                    {s && <Badge variant={TONE_BADGE[s.tone]}>{TONE_WORD[s.tone]}</Badge>}
                  </div>
                  {s === null ? (
                    <p className="text-sm text-muted-foreground">No readings yet.</p>
                  ) : (
                    <>
                      <dl className="grid grid-cols-3 gap-2">
                        {[
                          ["In stock", `${Math.round(s.latest).toLocaleString("en-US")}`, meta.unit],
                          ["Use per day", s.perDay === null ? "—" : s.perDay.toFixed(s.perDay < 10 ? 1 : 0), s.perDay === null ? "" : meta.unit],
                          ["Days left", s.daysLeft === null ? "∞" : Math.floor(s.daysLeft).toString(), "days"],
                        ].map(([label, value, unit]) => (
                          <div key={label} className="rounded-lg bg-muted/50 px-3 py-2">
                            <dt className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</dt>
                            <dd className={cn("text-xl font-semibold tabular-nums", label === "Days left" && s.tone !== "normal" && (s.tone === "emergency" ? "text-emergency" : "text-caution"))}>
                              {value} <span className="text-xs font-normal text-muted-foreground">{unit}</span>
                            </dd>
                          </div>
                        ))}
                      </dl>
                      <p className={cn("text-sm", s.tone === "emergency" ? "text-emergency" : s.tone === "caution" ? "text-caution" : "text-muted-foreground")}>{s.advice}</p>
                      <BurnDown readings={rs} status={s} now={now} />
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {me?.role === "commander" && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <p className="w-full text-sm font-semibold">Record a manual count (commander)</p>
            <label className="flex flex-col gap-1 text-sm">
              Resource
              <select value={count.resource} onChange={(e) => setCount((c) => ({ ...c, resource: e.target.value as Resource }))} className="h-9 rounded-md border border-border bg-background px-2">
                {ORDER.map((r) => (
                  <option key={r} value={r}>
                    {RESOURCES[r].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Quantity ({RESOURCES[count.resource].unit})
              <input type="number" min={0} value={count.quantity} onChange={(e) => setCount((c) => ({ ...c, quantity: e.target.value }))} className="h-9 w-32 rounded-md border border-border bg-background px-2 tabular-nums" />
            </label>
            <Button onClick={() => void record()} disabled={count.quantity === ""}>
              Record count
            </Button>
            {status && <span role="status" className="text-sm text-muted-foreground">{status}</span>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
