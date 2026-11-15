"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { MetricSpec } from "@/lib/dashboard/vital-thresholds";
import { inBand } from "@/lib/dashboard/vital-thresholds";

export interface TrendPoint {
  t: number; // epoch ms
  v: number;
}

const HEIGHT = 132;
const PAD = { top: 8, right: 12, bottom: 22, left: 36 };
// Colours come from the theme tokens in globals.css.
const BAND_FILL: Record<"caution" | "emergency", string> = {
  caution: "var(--color-caution)",
  emergency: "var(--color-emergency)",
};

/** Tick labels near an edge anchor inward so they are never clipped. */
function tickAnchor(x: number, width: number): "start" | "middle" | "end" {
  return x < PAD.left + 18 ? "start" : x > width - PAD.right - 18 ? "end" : "middle";
}

function niceStep(span: number, targetTicks: number): number {
  const raw = span / Math.max(1, targetTicks);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  return (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
}

function clock(t: number): string {
  return new Date(t).toISOString().slice(11, 16) + "Z";
}

/** Y domain: the data, stretched to the nearest caution threshold so headroom is visible. */
function yDomain(spec: MetricSpec, points: TrendPoint[]): [number, number] {
  const values = points.map((p) => p.v);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  const edges = spec.bands
    .filter((b) => b.tone === "caution")
    .map((b) => (b.side === "high" ? b.from : b.to))
    .filter((e): e is number => e !== null);
  if (edges.length > 0) {
    const mid = (lo + hi) / 2;
    const nearest = edges.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
    lo = Math.min(lo, nearest);
    hi = Math.max(hi, nearest);
  }
  const pad = Math.max((hi - lo) * 0.08, 10 ** -spec.digits);
  return [lo - pad, hi + pad];
}

export function TrendChart({
  spec,
  points,
  from,
  to,
}: {
  spec: MetricSpec;
  /** Ascending by time. */
  points: TrendPoint[];
  from: number;
  to: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(320);
  const [hover, setHover] = useState<number | null>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(Math.max(160, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length === 0) return null;
    const [lo, hi] = yDomain(spec, points);
    const plotW = width - PAD.left - PAD.right;
    const plotH = HEIGHT - PAD.top - PAD.bottom;
    const x = (t: number) => PAD.left + ((t - from) / (to - from)) * plotW;
    const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;

    // Break the line across gaps (station or sensor outage) instead of bridging them.
    const intervals = points.slice(1).map((p, i) => p.t - points[i]!.t).sort((a, b) => a - b);
    const typical = intervals[Math.floor(intervals.length / 2)] ?? 60_000;
    const gapMs = Math.max(typical * 3, 3 * 60_000);
    let d = "";
    points.forEach((p, i) => {
      const cmd = i === 0 || p.t - points[i - 1]!.t > gapMs ? "M" : "L";
      d += `${cmd}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    });

    const step = niceStep(hi - lo, 3);
    const yTicks: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yTicks.push(Number(v.toFixed(6)));

    const hourMs = 3_600_000;
    const tickMs = to - from > 2 * hourMs ? hourMs : 15 * 60_000;
    const xTicks: number[] = [];
    for (let t = Math.ceil(from / tickMs) * tickMs; t <= to; t += tickMs) xTicks.push(t);

    const bands = spec.bands
      .map((b) => {
        const top = Math.min(b.to ?? hi, hi);
        const bottom = Math.max(b.from ?? lo, lo);
        return top > bottom ? { tone: b.tone, y: y(top), h: y(bottom) - y(top) } : null;
      })
      .filter((b) => b !== null);

    return { x, y, d, yTicks, xTicks, bands, plotW, plotH, step };
  }, [spec, points, from, to, width]);

  const latest = points.at(-1);
  const values = points.map((p) => p.v);
  const summary =
    latest === undefined
      ? `${spec.label}: no samples in this range`
      : `${spec.label}: latest ${latest.v.toFixed(spec.digits)} ${spec.unit} at ${clock(latest.t)}, range ${Math.min(...values).toFixed(spec.digits)} to ${Math.max(...values).toFixed(spec.digits)} ${spec.unit}`;
  const outOfRange = latest !== undefined && spec.bands.some((b) => inBand(b, latest.v));

  function nearestIndex(clientX: number): number | null {
    const el = wrapRef.current;
    if (!el || !geo || points.length === 0) return null;
    const px = clientX - el.getBoundingClientRect().left;
    const t = from + ((px - PAD.left) / geo.plotW) * (to - from);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(points[i]!.t - t) < Math.abs(points[best]!.t - t)) best = i;
    return best;
  }

  function onKey(e: KeyboardEvent<SVGSVGElement>): void {
    if (points.length === 0) return;
    const last = points.length - 1;
    const cur = hover ?? last;
    const next =
      e.key === "ArrowLeft" ? Math.max(0, cur - 1)
      : e.key === "ArrowRight" ? Math.min(last, cur + 1)
      : e.key === "Home" ? 0
      : e.key === "End" ? last
      : null;
    if (next === null) return;
    e.preventDefault();
    setHover(next);
  }

  const hp = hover !== null ? points[hover] : undefined;

  return (
    <figure className="flex flex-col gap-1">
      <figcaption id={titleId} className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{spec.label}</span>
        {latest && (
          <span className="font-semibold text-foreground">
            {latest.v.toFixed(spec.digits)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">{spec.unit}</span>
            {outOfRange && <span className="sr-only"> (outside normal range)</span>}
          </span>
        )}
      </figcaption>
      <div ref={wrapRef} className="relative w-full">
        {geo === null ? (
          <div className="flex items-center justify-center rounded-md border border-border text-xs text-muted-foreground" style={{ height: HEIGHT }}>
            No samples in this range
          </div>
        ) : (
          <svg
            width={width}
            height={HEIGHT}
            role="img"
            aria-labelledby={titleId}
            aria-describedby={descId}
            tabIndex={0}
            onKeyDown={onKey}
            onFocus={() => setHover((h) => h ?? points.length - 1)}
            onBlur={() => setHover(null)}
            onPointerMove={(e: PointerEvent<SVGSVGElement>) => setHover(nearestIndex(e.clientX))}
            onPointerLeave={() => setHover(null)}
            className="block touch-pan-y rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <desc id={descId}>{summary}</desc>
            {geo.bands.map((b, i) => (
              <rect key={i} x={PAD.left} y={b.y} width={geo.plotW} height={b.h} fill={BAND_FILL[b.tone]} opacity={0.12} />
            ))}
            {geo.yTicks.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={PAD.left + geo.plotW} y1={geo.y(v)} y2={geo.y(v)} stroke="var(--color-border)" strokeWidth={1} />
                <text x={PAD.left - 6} y={geo.y(v)} dy="0.32em" textAnchor="end" fontSize={11} fill="var(--color-muted-foreground)" className="tabular-nums">
                  {v.toFixed(geo.step < 1 ? 1 : 0)}
                </text>
              </g>
            ))}
            {geo.xTicks.map((t) => (
              <text key={t} x={geo.x(t)} y={HEIGHT - 6} textAnchor={tickAnchor(geo.x(t), width)} fontSize={11} fill="var(--color-muted-foreground)" className="tabular-nums">
                {clock(t)}
              </text>
            ))}
            <path d={geo.d} fill="none" stroke="var(--color-series)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {latest && hp === undefined && (
              <circle cx={geo.x(latest.t)} cy={geo.y(latest.v)} r={4} fill="var(--color-series)" stroke="var(--color-card)" strokeWidth={2} />
            )}
            {hp && (
              <g pointerEvents="none">
                <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={PAD.top} y2={PAD.top + geo.plotH} stroke="var(--color-muted-foreground)" strokeWidth={1} />
                <circle cx={geo.x(hp.t)} cy={geo.y(hp.v)} r={4} fill="var(--color-series)" stroke="var(--color-card)" strokeWidth={2} />
              </g>
            )}
          </svg>
        )}
        {hp && geo && (
          <div
            role="status"
            className="pointer-events-none absolute top-0 rounded-md border border-border bg-card px-2 py-1 text-xs shadow"
            style={{
              left: Math.min(Math.max(geo.x(hp.t) - 48, 0), width - 104),
              width: 104,
            }}
          >
            <div className="font-semibold text-foreground tabular-nums">
              {hp.v.toFixed(spec.digits)} {spec.unit}
            </div>
            <div className="text-muted-foreground tabular-nums">{clock(hp.t)}</div>
          </div>
        )}
      </div>
    </figure>
  );
}
