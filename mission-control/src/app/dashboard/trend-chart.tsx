"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { MetricSpec } from "../../../../packages/vital-thresholds/index.ts";

// Ground counterpart of the crew app's src/components/trend-chart.tsx: same
// scales, gap breaks, bands and interaction, styled inline for Mission Control.

export interface TrendPoint {
  t: number;
  v: number;
}

const C = {
  series: "#4493f0", // validated single-series colour, same as the crew app
  card: "#11171f",
  border: "#263241",
  muted: "#8b98a5",
  text: "#e6edf3",
  caution: "#d29922",
  emergency: "#ff5c57",
};
const HEIGHT = 132;
const PAD = { top: 8, right: 12, bottom: 22, left: 36 };

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

export function TrendChart({ spec, points, from, to }: { spec: MetricSpec; points: TrendPoint[]; from: number; to: number }) {
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

    const intervals = points.slice(1).map((p, i) => p.t - points[i]!.t).sort((a, b) => a - b);
    const typical = intervals[Math.floor(intervals.length / 2)] ?? 60_000;
    const gapMs = Math.max(typical * 3, 3 * 60_000);
    let d = "";
    points.forEach((p, i) => {
      d += `${i === 0 || p.t - points[i - 1]!.t > gapMs ? "M" : "L"}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
    });

    const step = niceStep(hi - lo, 3);
    const yTicks: number[] = [];
    for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) yTicks.push(Number(v.toFixed(6)));
    const tickMs = to - from > 2 * 3_600_000 ? 3_600_000 : 15 * 60_000;
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

  function nearestIndex(clientX: number): number | null {
    const el = wrapRef.current;
    if (!el || !geo || points.length === 0) return null;
    const t = from + ((clientX - el.getBoundingClientRect().left - PAD.left) / geo.plotW) * (to - from);
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
  const text = { fontSize: 11, fill: C.muted, fontVariantNumeric: "tabular-nums" } as const;

  return (
    <figure style={{ margin: 0, display: "flex", flexDirection: "column", gap: 4 }}>
      <figcaption id={titleId} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", fontSize: 14 }}>
        <span style={{ color: C.muted }}>{spec.label}</span>
        {latest && (
          <span style={{ fontWeight: 600, color: C.text }}>
            {latest.v.toFixed(spec.digits)}
            <span style={{ marginLeft: 4, fontSize: 12, fontWeight: 400, color: C.muted }}>{spec.unit}</span>
          </span>
        )}
      </figcaption>
      <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
        {geo === null ? (
          <div style={{ height: HEIGHT, display: "flex", alignItems: "center", justifyContent: "center", border: `1px solid ${C.border}`, borderRadius: 6, color: C.muted, fontSize: 12 }}>
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
            onPointerMove={(e) => setHover(nearestIndex(e.clientX))}
            onPointerLeave={() => setHover(null)}
            style={{ display: "block", touchAction: "pan-y", borderRadius: 6 }}
          >
            <desc id={descId}>{summary}</desc>
            {geo.bands.map((b, i) => (
              <rect key={i} x={PAD.left} y={b.y} width={geo.plotW} height={b.h} fill={C[b.tone]} opacity={0.12} />
            ))}
            {geo.yTicks.map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={PAD.left + geo.plotW} y1={geo.y(v)} y2={geo.y(v)} stroke={C.border} strokeWidth={1} />
                <text x={PAD.left - 6} y={geo.y(v)} dy="0.32em" textAnchor="end" style={text}>
                  {v.toFixed(geo.step < 1 ? 1 : 0)}
                </text>
              </g>
            ))}
            {geo.xTicks.map((t) => (
              <text key={t} x={geo.x(t)} y={HEIGHT - 6} textAnchor={tickAnchor(geo.x(t), width)} style={text}>
                {clock(t)}
              </text>
            ))}
            <path d={geo.d} fill="none" stroke={C.series} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            {latest && hp === undefined && <circle cx={geo.x(latest.t)} cy={geo.y(latest.v)} r={4} fill={C.series} stroke={C.card} strokeWidth={2} />}
            {hp && (
              <g pointerEvents="none">
                <line x1={geo.x(hp.t)} x2={geo.x(hp.t)} y1={PAD.top} y2={PAD.top + geo.plotH} stroke={C.muted} strokeWidth={1} />
                <circle cx={geo.x(hp.t)} cy={geo.y(hp.v)} r={4} fill={C.series} stroke={C.card} strokeWidth={2} />
              </g>
            )}
          </svg>
        )}
        {hp && geo && (
          <div
            role="status"
            style={{
              pointerEvents: "none",
              position: "absolute",
              top: 0,
              left: Math.min(Math.max(geo.x(hp.t) - 48, 0), width - 104),
              width: 104,
              background: C.card,
              border: `1px solid ${C.border}`,
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 12,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <div style={{ fontWeight: 600, color: C.text }}>
              {hp.v.toFixed(spec.digits)} {spec.unit}
            </div>
            <div style={{ color: C.muted }}>{clock(hp.t)}</div>
          </div>
        )}
      </div>
    </figure>
  );
}
