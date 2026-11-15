"use client";

import { CloudLightning, ShieldAlert } from "lucide-react";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { runSolarDrill } from "./actions";

/** Demo-only button that starts a solar particle event drill. */
export function DrillButton() {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  return (
    <div className="flex flex-col gap-1.5 border-t border-border pt-3">
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const r = await runSolarDrill();
            setMsg(r.ok ? { tone: "ok", text: "Drill started: dose rate spiking, alarm will sound." } : { tone: "error", text: r.error });
          })
        }
      >
        <CloudLightning aria-hidden /> {pending ? "Starting drill…" : "Run solar storm drill"}
      </Button>
      <p className="text-xs text-muted-foreground">Demo only. Simulates a solar particle event for all crew.</p>
      {msg && (
        <p role="status" className={msg.tone === "ok" ? "text-xs text-info" : "text-xs text-emergency"}>
          {msg.text}
        </p>
      )}
    </div>
  );
}

const STEPS = [
  "Move to the storm shelter (water-wall sleep station)",
  "Bring personal dosimeters; leave other tasks safe",
  "Report headcount to the commander",
  "Stay sheltered until dose rate is below 250 µSv/h",
] as const;

/** Shown while any crew dose rate is at emergency level. Ticks are per device. */
export function ShelterChecklist({ peak }: { peak: number }) {
  const [done, setDone] = useState<boolean[]>(() => STEPS.map(() => false));
  return (
    <div role="region" aria-label="Storm shelter protocol" className="rounded-md border-2 border-emergency bg-emergency/10 p-3">
      <p className="flex items-center gap-2 text-sm font-bold text-emergency">
        <ShieldAlert className="size-4" aria-hidden /> STORM SHELTER · dose rate {Math.round(peak).toLocaleString("en-US")} µSv/h
      </p>
      <ol className="mt-2 flex flex-col gap-1.5 text-sm">
        {STEPS.map((step, i) => (
          <li key={step}>
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-[var(--color-emergency)]"
                checked={done[i]}
                onChange={(e) => setDone((d) => d.map((x, j) => (j === i ? e.target.checked : x)))}
              />
              <span className={done[i] ? "text-muted-foreground line-through" : ""}>
                {i + 1}. {step}
              </span>
            </label>
          </li>
        ))}
      </ol>
    </div>
  );
}
