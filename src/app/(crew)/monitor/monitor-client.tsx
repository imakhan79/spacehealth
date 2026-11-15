"use client";

import { Activity, HeartPulse } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { useConnectivity } from "@/components/connectivity-provider";
import { analyzeRhythm, beatsBetween, ecgValue } from "@/lib/ecg";
import { cn } from "@/lib/utils";
import { HowTo } from "@/components/how-to";

interface Lead {
  id: string;
  callsign: string;
  hr: number | null;
  /** Demo: synthesize premature beats when an alert reports them. */
  pvcEvery: number;
}

const WINDOW_S = 5; // seconds across the strip (25 mm/s paper → 125 mm)
const REFRESH_MS = 10_000;

function Strip({ lead }: { lead: Lead }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [rhythm, setRhythm] = useState<ReturnType<typeof analyzeRhythm>>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap || lead.hr === null) return;
    const hr = lead.hr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const css = getComputedStyle(document.documentElement);
    const trace = css.getPropertyValue("--color-ok").trim() || "#3fb950";
    const grid = css.getPropertyValue("--color-border").trim() || "#263241";
    let frame = 0;
    let lastDraw = 0;

    const draw = (nowMs: number) => {
      const w = wrap.clientWidth;
      const h = 140;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== Math.round(w * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
        canvas.style.height = `${h}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      // ECG paper: 1 mm (0.04 s) minor and 5 mm (0.2 s) major lines.
      const pxPerS = w / WINDOW_S;
      for (let s = 0; s <= WINDOW_S + 1e-9; s += 0.04) {
        const major = Math.abs(s / 0.2 - Math.round(s / 0.2)) < 1e-6;
        ctx.strokeStyle = grid;
        ctx.globalAlpha = major ? 0.55 : 0.18;
        ctx.beginPath();
        ctx.moveTo(s * pxPerS, 0);
        ctx.lineTo(s * pxPerS, h);
        ctx.stroke();
      }
      for (let y = 0; y <= h; y += pxPerS * 0.04) {
        const major = Math.round(y / (pxPerS * 0.04)) % 5 === 0;
        ctx.globalAlpha = major ? 0.55 : 0.18;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;

      // Sweep: the trace is written left to right; an erase gap leads the pen.
      const t = nowMs / 1000;
      const sweepStart = Math.floor(t / WINDOW_S) * WINDOW_S;
      const beats = beatsBetween(hr, t - WINDOW_S - 1, t + 1, lead.pvcEvery);
      const prevBeats = beatsBetween(hr, sweepStart - WINDOW_S - 1, sweepStart + 1, lead.pvcEvery);
      const pen = (t - sweepStart) * pxPerS;
      const gap = 18;
      const baseline = h * 0.62;
      const scale = h * 0.42;
      ctx.lineWidth = 2;
      ctx.lineJoin = "round";
      ctx.strokeStyle = trace;
      const segment = (fromPx: number, toPx: number, offset: number, src: typeof beats) => {
        if (toPx <= fromPx) return;
        ctx.beginPath();
        for (let x = fromPx; x <= toPx; x += 1) {
          const y = baseline - ecgValue(offset + x / pxPerS, src) * scale;
          if (x === fromPx) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      };
      // New sweep up to the pen; the previous sweep beyond the erase gap.
      segment(0, pen, sweepStart, beats);
      segment(Math.min(w, pen + gap), w, sweepStart - WINDOW_S, prevBeats);
      ctx.fillStyle = trace;
      ctx.beginPath();
      ctx.arc(pen, baseline - ecgValue(t, beats) * scale, 3, 0, Math.PI * 2);
      ctx.fill();
    };

    const loop = (ms: number) => {
      // Reduced motion: a still strip refreshed every 2 s.
      if (!reduced || ms - lastDraw > 2000) {
        draw(performance.timeOrigin + ms);
        lastDraw = ms;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);

    const analyse = () => {
      const now = Date.now() / 1000;
      setRhythm(analyzeRhythm(beatsBetween(hr, now - 30, now, lead.pvcEvery).map((b) => b.t)));
    };
    analyse();
    const timer = window.setInterval(analyse, 5000);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timer);
    };
  }, [lead.hr, lead.pvcEvery]);

  const caution = rhythm?.tone === "caution";
  return (
    <Card className={cn(caution && "border-caution/50")}>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold">{lead.callsign}</span>
          <span className="text-xs text-muted-foreground">Lead II · 25 mm/s · simulated from heart-rate telemetry</span>
          <div className="ml-auto flex items-baseline gap-1">
            <HeartPulse className="size-4 self-center text-emergency motion-safe:animate-pulse" aria-hidden />
            <span className="text-3xl font-semibold tabular-nums">{lead.hr === null ? "—" : Math.round(lead.hr)}</span>
            <span className="text-xs text-muted-foreground">bpm</span>
          </div>
        </div>
        <div ref={wrapRef} className="w-full overflow-hidden rounded-lg bg-background/70">
          {lead.hr === null ? (
            <p className="flex h-[140px] items-center justify-center text-sm text-muted-foreground">No recent heart-rate telemetry</p>
          ) : (
            <canvas ref={canvasRef} className="block w-full" role="img" aria-label={`${lead.callsign} ECG trace. ${rhythm?.label ?? "Analysing rhythm"}.`} />
          )}
        </div>
        {rhythm && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <span className={cn("font-semibold", caution ? "text-caution" : "text-ok")}>{rhythm.label}</span>
            <span className="text-muted-foreground tabular-nums">Monitor rate {rhythm.rate} bpm</span>
            {rhythm.prematurePerMin > 0 && <span className="text-caution tabular-nums">≈ {rhythm.prematurePerMin.toFixed(0)} premature beats/min</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function MonitorClient() {
  const { client } = useConnectivity();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const [crew, hr, alerts] = await Promise.all([
      client.from("crew_members").select("id, callsign").eq("is_active", true).neq("role", "sensor_gateway").order("callsign"),
      client.from("crew_telemetry").select("crew_member_id, value, recorded_at").eq("metric", "heart_rate").gte("recorded_at", new Date(Date.now() - 10 * 60_000).toISOString()).order("recorded_at", { ascending: false }).limit(100),
      client.from("health_alerts").select("crew_member_id, message").in("status", ["active", "acknowledged", "overridden"]).ilike("message", "%premature%"),
    ]);
    if (crew.error || hr.error || alerts.error) {
      // Never animate stale data as if it were a live trace.
      setLeads(null);
      setError("Station server not responding: no live ECG. Traces resume automatically when it is back.");
      return;
    }
    setError(null);
    const latest = new Map<string, number>();
    for (const r of hr.data ?? []) if (!latest.has(r.crew_member_id)) latest.set(r.crew_member_id, r.value);
    const pvc = new Set((alerts.data ?? []).map((a) => a.crew_member_id));
    setLeads(
      (crew.data ?? [])
        .filter((c) => latest.has(c.id))
        .map((c) => ({ id: c.id, callsign: c.callsign, hr: latest.get(c.id) ?? null, pvcEvery: pvc.has(c.id) ? 9 : 0 })),
    );
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const flagged = useMemo(() => (leads ?? []).filter((l) => l.pvcEvery > 0).map((l) => l.callsign), [leads]);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Activity className="size-6 text-ok" aria-hidden /> ECG monitor
      </h1>
      <HowTo page="monitor" />
      <p className="text-sm text-muted-foreground">
        Live traces for each crew member. This demo has no ECG electrodes: traces are synthesized from heart-rate telemetry, and the rhythm analysis reads the
        beats the same way a monitor reads R peaks.
        {flagged.length > 0 && ` Premature beats are simulated for ${flagged.join(", ")} while an ECG alert is open.`}
      </p>
      {error && <p className="text-sm text-caution">{error}</p>}
      {leads === null ? (
        !error && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : leads.length === 0 ? (
        <p className="text-sm text-muted-foreground">No crew with recent heart-rate telemetry.</p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {leads.map((l) => (
            <Strip key={l.id} lead={l} />
          ))}
        </div>
      )}
    </div>
  );
}
