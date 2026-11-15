"use client";

import { AlertOctagon, AlertTriangle, BellOff, Check, Volume2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { alarmLevel, alarmingAlerts, shouldSound, silenceNow, type AlarmLevel, type Silence } from "@/lib/dashboard/alarm";
import { canPerform, type AlertAction } from "@/lib/dashboard/alert-mutations";
import type { CrewMember, HealthAlert, Me } from "@/lib/dashboard/types";
import { Ago, useNow } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const SILENCE_KEY = "omni:alarm-silence";
const MAX_LISTED = 3;

// Emergency: fast triple beep every 1.5 s. Warning: slower two-tone every 4 s.
const PATTERN: Record<AlarmLevel, { everyMs: number; tones: { hz: number; at: number; dur: number }[] }> = {
  emergency: {
    everyMs: 1500,
    tones: [
      { hz: 880, at: 0, dur: 0.12 },
      { hz: 880, at: 0.18, dur: 0.12 },
      { hz: 880, at: 0.36, dur: 0.12 },
    ],
  },
  warning: {
    everyMs: 4000,
    tones: [
      { hz: 660, at: 0, dur: 0.25 },
      { hz: 520, at: 0.3, dur: 0.25 },
    ],
  },
};

function readSilence(): Silence | null {
  try {
    const raw = window.sessionStorage.getItem(SILENCE_KEY);
    return raw ? (JSON.parse(raw) as Silence) : null;
  } catch {
    return null;
  }
}

function writeSilence(s: Silence | null): void {
  try {
    if (s) window.sessionStorage.setItem(SILENCE_KEY, JSON.stringify(s));
    else window.sessionStorage.removeItem(SILENCE_KEY);
  } catch {
    // Storage unavailable: the silence still holds for this page.
  }
}

/** Web Audio beeper. Browsers keep it suspended until the user interacts with the page. */
function useBeeper() {
  const ctxRef = useRef<AudioContext | null>(null);
  const [blocked, setBlocked] = useState(false);

  const ctx = useCallback((): AudioContext | null => {
    if (typeof window === "undefined" || !("AudioContext" in window)) return null;
    ctxRef.current ??= new AudioContext();
    return ctxRef.current;
  }, []);

  const unlock = useCallback(async (): Promise<void> => {
    const c = ctx();
    if (!c) return;
    try {
      await c.resume();
    } catch {
      // Still blocked; the button stays visible.
    }
    setBlocked(c.state !== "running");
  }, [ctx]);

  // Any interaction with the page also unlocks sound.
  useEffect(() => {
    const onGesture = (): void => void unlock();
    window.addEventListener("pointerdown", onGesture);
    window.addEventListener("keydown", onGesture);
    return () => {
      window.removeEventListener("pointerdown", onGesture);
      window.removeEventListener("keydown", onGesture);
    };
  }, [unlock]);

  const play = useCallback(
    (level: AlarmLevel): void => {
      const c = ctx();
      if (!c) return;
      if (c.state !== "running") {
        setBlocked(true);
        void c.resume().then(() => setBlocked(c.state !== "running"), () => undefined);
        return;
      }
      setBlocked(false);
      const t0 = c.currentTime + 0.02;
      for (const tone of PATTERN[level].tones) {
        const osc = c.createOscillator();
        const gain = c.createGain();
        osc.type = "square";
        osc.frequency.value = tone.hz;
        // Short attack/release so beeps don't click.
        gain.gain.setValueAtTime(0, t0 + tone.at);
        gain.gain.linearRampToValueAtTime(0.12, t0 + tone.at + 0.01);
        gain.gain.setValueAtTime(0.12, t0 + tone.at + tone.dur - 0.02);
        gain.gain.linearRampToValueAtTime(0, t0 + tone.at + tone.dur);
        osc.connect(gain).connect(c.destination);
        osc.start(t0 + tone.at);
        osc.stop(t0 + tone.at + tone.dur + 0.01);
      }
    },
    [ctx],
  );

  return { play, blocked, unlock };
}

interface Props {
  alerts: HealthAlert[];
  crewById: Map<string, CrewMember>;
  me: Me | null;
  pendingIds: Set<string>;
  onAction: (alert: HealthAlert, action: AlertAction, reason: string | null) => Promise<void>;
}

export function AlarmBanner({ alerts, crewById, me, pendingIds, onAction }: Props) {
  const alarming = useMemo(() => alarmingAlerts(alerts), [alerts]);
  const level = alarmLevel(alarming);
  const [silence, setSilence] = useState<Silence | null>(null);
  const clock = useNow();
  const [tick, setTick] = useState(0);
  const { play, blocked, unlock } = useBeeper();

  useEffect(() => setSilence(readSilence()), []);
  // A 1 s tick so the silence countdown and expiry are exact.
  useEffect(() => {
    const timer = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // tick re-renders every second; null until hydrated.
  const now = clock === null ? null : tick >= 0 ? Date.now() : clock;

  // Before hydration nothing sounds; the banner itself still renders on the server.
  const sounding = level !== null && now !== null && shouldSound(alarming, silence, now);

  // Beep on the level's cadence while sounding.
  useEffect(() => {
    if (!sounding || level === null) return;
    play(level);
    // Browsers ignore vibration (and log an intervention) before the user has interacted.
    if ("vibrate" in navigator && navigator.userActivation?.hasBeenActive) navigator.vibrate(level === "emergency" ? [200, 100, 200, 100, 200] : [300]);
    const timer = window.setInterval(() => play(level), PATTERN[level].everyMs);
    return () => window.clearInterval(timer);
  }, [sounding, level, play]);

  // Flag the tab title so the alarm is visible from another tab too.
  useEffect(() => {
    if (level === null) return;
    const base = document.title;
    document.title = `${level === "emergency" ? "EMERGENCY" : "WARNING"} · ${base}`;
    return () => {
      document.title = base;
    };
  }, [level]);

  if (level === null) return null;

  const silenced = now !== null && !sounding;
  const silenceLeftMin = silence && now !== null ? Math.max(1, Math.ceil((silence.until - now) / 60_000)) : 0;
  const emergency = level === "emergency";
  const Icon = emergency ? AlertOctagon : AlertTriangle;

  return (
    <section
      role="alertdialog"
      aria-labelledby="alarm-title"
      aria-live="assertive"
      className={cn(
        "z-20 flex sm:sticky sm:top-20 flex-col gap-3 rounded-lg border-2 px-4 py-3 shadow-lg backdrop-blur",
        emergency ? "border-emergency bg-emergency/15" : "border-warning bg-warning/15",
        !silenced && "motion-safe:animate-pulse",
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Icon className={cn("size-6 shrink-0", emergency ? "text-emergency" : "text-warning")} aria-hidden />
        <h2 id="alarm-title" className={cn("text-base font-bold tracking-wide", emergency ? "text-emergency" : "text-warning")}>
          {emergency ? "EMERGENCY" : "WARNING"} · {alarming.length} unacknowledged
        </h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {blocked && !silenced && (
            <Button size="sm" variant="outline" onClick={() => void unlock()}>
              <Volume2 aria-hidden /> Enable alarm sound
            </Button>
          )}
          {silenced ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <BellOff className="size-3.5" aria-hidden /> Silenced · {silenceLeftMin} min
            </span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const s = silenceNow(alarming, Date.now());
                setSilence(s);
                writeSilence(s);
              }}
            >
              <BellOff aria-hidden /> Silence 5 min
            </Button>
          )}
        </div>
      </div>
      <ul className="flex flex-col gap-2">
        {alarming.slice(0, MAX_LISTED).map((a) => {
          const who = crewById.get(a.crew_member_id)?.callsign ?? "Crew";
          const allowed = me ? canPerform(a, "acknowledge", me) : { ok: false as const, reason: "Signing in…" };
          const pending = pendingIds.has(a.id);
          return (
            <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-card/80 px-3 py-2 text-sm">
              <span className={cn("text-xs font-bold", a.severity === "emergency" ? "text-emergency" : "text-warning")}>
                {a.severity.toUpperCase()}
              </span>
              <span className="font-semibold">{who}</span>
              <span className="min-w-0 flex-1">{a.message}</span>
              <span className="text-xs text-muted-foreground"><Ago iso={a.triggered_at} /></span>
              <Button
                size="sm"
                disabled={!allowed.ok || pending}
                title={allowed.ok ? undefined : allowed.reason}
                onClick={() => void onAction(a, "acknowledge", null)}
              >
                <Check aria-hidden /> {pending ? "Sending…" : "Acknowledge"}
              </Button>
            </li>
          );
        })}
      </ul>
      {alarming.length > MAX_LISTED && (
        <a href="#alerts-heading" className="text-sm text-muted-foreground underline">
          {alarming.length - MAX_LISTED} more in Health alerts
        </a>
      )}
    </section>
  );
}
