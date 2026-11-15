"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatDuration, type LinkBatch } from "@/lib/link-stats";

// One thin column per received batch at its arrival time; height = entries.
// Irregular events on a time axis, so columns sit at true positions rather
// than in category slots. The longest no-contact stretch is shaded and labelled.

const C = {
  series: "#4493f0",
  card: "#11171f",
  border: "#263241",
  muted: "#8b98a5",
  text: "#e6edf3",
  gap: "#8b98a5",
  conflict: "#f0883e",
};
const HEIGHT = 168;
const PAD = { top: 22, right: 12, bottom: 22, left: 44 };
const BAR_W = 6;

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

function stamp(t: number, span: number): string {
  const iso = new Date(t).toISOString();
  return span > 2 * 86_400_000 ? `${iso.slice(5, 10)}` : `${iso.slice(11, 16)}Z`;
}

export function LinkTimeline({
  batches,
  from,
  to,
  gap,
}: {
  batches: LinkBatch[];
  from: number;
  to: number;
  gap: { from: number; to: number; ms: number; open: boolean } | null;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  const [hover, setHover] = useState<number | null>(null);
  const descId = useId();
  const shown = useMemo(() => batches.filter((b) => b.receivedAt >= from && b.receivedAt <= to), [batches, from, to]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setWidth(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const x = (t: number) => PAD.left + ((t - from) / (to - from)) * plotW;
  const maxEntries = Math.max(1, ...shown.map((b) => b.entries));
  const step = niceStep(maxEntries, 3);
  const top = Math.ceil(maxEntries / step) * step;
  const y = (v: number) => PAD.top + (1 - v / top) * plotH;
  const yTicks: number[] = [];
  for (let v = 0; v <= top; v += step) yTicks.push(v);
  const span = to - from;
  const tickMs = span > 10 * 86_400_000 ? 5 * 86_400_000 : span > 2 * 86_400_000 ? 86_400_000 : span > 12 * 3_600_000 ? 4 * 3_600_000 : 3_600_000;
  const xTicks: number[] = [];
  for (let t = Math.ceil(from / tickMs) * tickMs; t <= to; t += tickMs) xTicks.push(t);
  const anchor = (px: number) => (px < PAD.left + 20 ? "start" : px > width - PAD.right - 20 ? "end" : "middle");

  const summary =
    shown.length === 0
      ? "No uplink batches received in this range."
      : `${shown.length} uplink batches, ${shown.reduce((n, b) => n + b.entries, 0)} entries.` +
        (gap ? ` Longest stretch without contact ${formatDuration(gap.ms)}${gap.open ? ", still open" : ""}.` : "");

  function onKey(e: KeyboardEvent<SVGSVGElement>): void {
    if (shown.length === 0) return;
    const last = shown.length - 1;
    const cur = hover ?? last;
    const next = e.key === "ArrowLeft" ? Math.max(0, cur - 1) : e.key === "ArrowRight" ? Math.min(last, cur + 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    setHover(next);
  }

  const hb = hover !== null ? shown[hover] : undefined;
  const label = { fontSize: 11, fill: C.muted, fontVariantNumeric: "tabular-nums" } as const;

  return (
    <div ref={wrapRef} style={{ position: "relative", width: "100%" }}>
      <svg
        width={width}
        height={HEIGHT}
        role="img"
        aria-label="Uplink batches over time"
        aria-describedby={descId}
        tabIndex={0}
        onKeyDown={onKey}
        onFocus={() => setHover((h) => h ?? (shown.length ? shown.length - 1 : null))}
        onBlur={() => setHover(null)}
        onPointerLeave={() => setHover(null)}
        style={{ display: "block", touchAction: "pan-y" }}
      >
        <desc id={descId}>{summary}</desc>
        {gap && (
          <g>
            <rect x={x(gap.from)} y={PAD.top} width={Math.max(0, x(gap.to) - x(gap.from))} height={plotH} fill={C.gap} opacity={0.08} />
            {x(gap.to) - x(gap.from) > 120 && (
              <text x={(x(gap.from) + x(gap.to)) / 2} y={PAD.top - 8} textAnchor="middle" style={label}>
                {gap.open ? "No contact for " : "Longest gap "}
                {formatDuration(gap.ms)}
              </text>
            )}
          </g>
        )}
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} stroke={C.border} strokeWidth={1} />
            <text x={PAD.left - 6} y={y(v)} dy="0.32em" textAnchor="end" style={label}>
              {v >= 10_000 ? `${Math.round(v / 1000)}K` : v.toLocaleString("en-US")}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <text key={t} x={x(t)} y={HEIGHT - 6} textAnchor={anchor(x(t))} style={label}>
            {stamp(t, span)}
          </text>
        ))}
        {shown.map((b, i) => {
          const cx = x(b.receivedAt);
          const h = Math.max(2, y(0) - y(b.entries));
          const r = Math.min(3, h / 2, BAR_W / 2);
          const active = hover === i;
          return (
            <g key={b.batchId}>
              {/* Rounded data end, square at the baseline; radius shrinks for tiny columns. */}
              <path
                d={`M${cx - BAR_W / 2},${y(0)} V${y(0) - h + r} q0,-${r} ${r},-${r} h${BAR_W - 2 * r} q${r},0 ${r},${r} V${y(0)} Z`}
                fill={b.conflicts > 0 ? C.conflict : C.series}
                opacity={hover === null || active ? 1 : 0.55}
              />
              {/* Hit target wider than the mark. */}
              <rect x={cx - 12} y={PAD.top} width={24} height={plotH} fill="transparent" onPointerEnter={() => setHover(i)} />
            </g>
          );
        })}
      </svg>
      {hb && (
        <div
          role="status"
          style={{
            position: "absolute",
            top: 0,
            left: Math.min(Math.max(x(hb.receivedAt) - 90, 0), width - 180),
            width: 180,
            pointerEvents: "none",
            background: C.card,
            border: `1px solid ${C.border}`,
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 12,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <div style={{ fontWeight: 600, color: C.text }}>{hb.entries.toLocaleString("en-US")} entries</div>
          <div style={{ color: C.muted }}>{new Date(hb.receivedAt).toISOString().slice(0, 19).replace("T", " ")}Z</div>
          <div style={{ color: C.muted }}>
            {(hb.bytes / 1024).toFixed(1)} KB gzip · transit {formatDuration(Math.max(0, hb.receivedAt - hb.createdAt))}
          </div>
          {hb.conflicts > 0 && <div style={{ color: C.conflict }}>{hb.conflicts} conflict(s)</div>}
        </div>
      )}
    </div>
  );
}
