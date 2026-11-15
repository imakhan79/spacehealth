"use client";

import { AudioLines, BellRing, Radiation, Users, type LucideIcon } from "lucide-react";
import type { AcousticWindow, CrewMember, HealthAlert, Vital } from "@/lib/dashboard/types";
import { METRICS, RADIATION, doseRateTone, latestRadiation, toneOf, type Tone } from "@/lib/dashboard/vital-thresholds";
import { useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const ACCENT: Record<Tone, { bar: string; chip: string; text: string }> = {
  normal: { bar: "bg-ok", chip: "bg-ok/15 text-ok", text: "text-foreground" },
  caution: { bar: "bg-caution", chip: "bg-caution/15 text-caution", text: "text-caution" },
  emergency: { bar: "bg-emergency", chip: "bg-emergency/15 text-emergency", text: "text-emergency" },
};

function Tile({ icon: Icon, label, value, unit, note, tone }: { icon: LucideIcon; label: string; value: string; unit?: string; note: string; tone: Tone }) {
  const a = ACCENT[tone];
  return (
    <div className="relative overflow-hidden rounded-xl border border-border/80 bg-gradient-to-b from-card to-card/70 p-4 shadow-[inset_0_1px_0_0_rgb(255_255_255/0.04)]">
      <span className={cn("absolute inset-y-0 left-0 w-1", a.bar)} aria-hidden />
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
        <span className={cn("flex size-7 items-center justify-center rounded-lg", a.chip)}>
          <Icon className="size-4" aria-hidden />
        </span>
        {label}
      </div>
      <div className={cn("mt-3 text-3xl font-semibold tracking-tight", a.text)}>
        {value}
        {unit && <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function worst(a: Tone, b: Tone): Tone {
  return a === "emergency" || b === "emergency" ? "emergency" : a === "caution" || b === "caution" ? "caution" : "normal";
}

export function Overview({ crew, vitals, alerts, acoustics, me }: { crew: CrewMember[]; vitals: Vital[]; alerts: HealthAlert[]; acoustics: AcousticWindow[]; me: string | null }) {
  const now = useNow();

  // Open alerts.
  const open = alerts.filter((a) => a.status === "active");
  const emergencies = open.filter((a) => a.severity === "emergency").length;
  const warnings = open.filter((a) => a.severity === "warning").length;
  const alertTone: Tone = emergencies > 0 ? "emergency" : warnings > 0 || open.length > 0 ? "caution" : "normal";

  // Crew whose newest sample of every charted vital is in the normal range.
  const withVitals = crew.filter((c) => vitals.some((v) => v.crew_member_id === c.id));
  const outOfRange = withVitals.filter((c) =>
    METRICS.some((m) => {
      const v = vitals.find((x) => x.crew_member_id === c.id && x.metric === m.key);
      return v !== undefined && toneOf(m, v.value) !== "normal";
    }),
  );
  const crewTone: Tone = outOfRange.reduce<Tone>((t, c) => {
    const tones = METRICS.map((m) => {
      const v = vitals.find((x) => x.crew_member_id === c.id && x.metric === m.key);
      return v ? toneOf(m, v.value) : "normal";
    });
    return tones.reduce(worst, t);
  }, "normal");

  // Peak crew dose rate.
  const rates = [...latestRadiation(vitals).values()].map((r) => r.doseRate).filter((r): r is number => r !== null);
  const peak = rates.length ? Math.max(...rates) : null;

  // Loudest module (latest window per module).
  const latestByModule = new Map<string, AcousticWindow>();
  for (const w of acoustics) if (!latestByModule.has(w.module_id)) latestByModule.set(w.module_id, w);
  const modules = [...latestByModule.values()];
  const loudest = modules.reduce<AcousticWindow | null>((m, w) => (m === null || w.laeq_dba > m.laeq_dba ? w : m), null);
  const overLimit = modules.filter((w) => w.limit_exceeded).length;

  const callsign = new Map(crew.map((c) => [c.id, c.callsign]));
  const clock = now === null ? null : new Date(now).toISOString();

  return (
    <section aria-labelledby="overview-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-info">Crew health</p>
          <h1 id="overview-heading" className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Mission overview
          </h1>
        </div>
        <p className="text-sm tabular-nums text-muted-foreground" aria-live="off">
          {clock ? `${clock.slice(0, 10)} · ${clock.slice(11, 19)} UTC` : " "}
          {me && <span className="hidden sm:inline"> · signed in as {me}</span>}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Tile
          icon={BellRing}
          label="Open alerts"
          value={String(open.length)}
          tone={alertTone}
          note={open.length === 0 ? "All clear" : [emergencies && `${emergencies} emergency`, warnings && `${warnings} warning`, open.length - emergencies - warnings && `${open.length - emergencies - warnings} other`].filter(Boolean).join(" · ")}
        />
        <Tile
          icon={Users}
          label="Crew within limits"
          value={`${withVitals.length - outOfRange.length}/${withVitals.length}`}
          tone={crewTone}
          note={outOfRange.length === 0 ? "All vitals in normal range" : `Out of range: ${outOfRange.map((c) => callsign.get(c.id)).join(", ")}`}
        />
        <Tile
          icon={Radiation}
          label="Peak dose rate"
          value={peak === null ? "—" : Math.round(peak).toLocaleString("en-US")}
          unit={peak === null ? undefined : RADIATION.doseRateUnit}
          tone={peak === null ? "normal" : doseRateTone(peak)}
          note={peak === null ? "No dosimeter data" : doseRateTone(peak) === "emergency" ? "Storm shelter now" : doseRateTone(peak) === "caution" ? "Elevated: limit time in exposed modules" : "Deep-space background"}
        />
        <Tile
          icon={AudioLines}
          label="Loudest module"
          value={loudest ? loudest.laeq_dba.toFixed(1) : "—"}
          unit={loudest ? "dBA" : undefined}
          tone={overLimit > 0 ? "caution" : "normal"}
          note={loudest ? `${loudest.module_id}${overLimit > 0 ? ` · ${overLimit} module${overLimit === 1 ? "" : "s"} over limit` : " · all within limits"}` : "No acoustic data"}
        />
      </div>
    </section>
  );
}
