import {
  Activity,
  ArrowRight,
  BellRing,
  ClipboardList,
  HeartHandshake,
  HeartPulse,
  History,
  LineChart,
  Map as MapIcon,
  Radiation,
  Satellite,
  ServerCog,
  ShieldCheck,
  Siren,
  WifiOff,
  type LucideIcon,
} from "lucide-react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { AUTH_COOKIE_NAME, demoLogin } from "@/lib/supabase/config";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "OMNI · Ambient crew health monitoring",
  description: "Crew health monitoring for deep-space missions that keeps working with no Earth link.",
};

const FEATURES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: HeartPulse, title: "Live vitals & early warning", text: "Heart rate, SpO₂, breathing and core temperature for every crew member, with a trend forecast that warns before a value crosses into caution." },
  { icon: BellRing, title: "Cabin alarm", text: "Warnings and emergencies sound aboard, flag the tab and vibrate. Silence covers only what's already showing: a new alarm always sounds." },
  { icon: Radiation, title: "Radiation & storm drills", text: "Career dose against NASA's 600 mSv limit, live dose rate, and a solar-storm drill that walks the crew into the shelter." },
  { icon: HeartHandshake, title: "Crew care", text: "Daily wellness check-ins, medication schedules, the medical kit, exercise countermeasures, and an explainable readiness score." },
  { icon: MapIcon, title: "Habitat & cabin air", text: "A live module map coloured by noise, CO₂ or radiation, with crew locations and plain-language air warnings." },
  { icon: Siren, title: "Guided emergency procedures", text: "Step-by-step protocols with timers. Every step records who did it and when; critical steps gate completion." },
  { icon: History, title: "Timeline & shift handover", text: "Everything that happened aboard in one searchable timeline, and a printable handover report for the incoming shift." },
  { icon: Satellite, title: "Earth uplink & inbox", text: "Data syncs to Mission Control whenever the Deep Space Network link is up; messages from the ground land in the crew inbox." },
];

const PRINCIPLES: { icon: LucideIcon; title: string; text: string }[] = [
  { icon: WifiOff, title: "No Earth link required", text: "Everything runs on the spacecraft's own server. Earth is a bonus, not a dependency." },
  { icon: ShieldCheck, title: "Private by default", text: "Crew see their own records; only the flight surgeon and commander see everyone's. Who did what is stamped by the server." },
  { icon: ServerCog, title: "Fails safe", text: "If the station server hiccups, tablets keep showing cached data and queue actions instead of locking the crew out." },
];

function Preview() {
  // A static illustration of the dashboard, not live data.
  const crew = [
    { cs: "CDR", hr: 68, spo2: 99, tone: "ok", label: "Nominal" },
    { cs: "MS1", hr: 115, spo2: 95, tone: "caution", label: "Caution" },
    { cs: "SUR", hr: 96, spo2: 98, tone: "ok", label: "Nominal" },
  ] as const;
  return (
    <div className="relative" aria-hidden>
      <div className="absolute -inset-6 rounded-[2rem] bg-gradient-to-br from-info/20 via-transparent to-ok/10 blur-2xl" />
      <div className="relative rounded-2xl border border-border/80 bg-card/80 p-4 shadow-2xl backdrop-blur">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <span className="flex items-center gap-2 text-sm font-semibold tracking-[0.2em]">
            <Activity className="size-4 text-info" /> OMNI
          </span>
          <span className="rounded-full border border-info/40 bg-info/10 px-2 py-0.5 text-[10px] text-info">Local mode · all data aboard</span>
        </div>
        <div className="mt-3 grid grid-cols-4 gap-2">
          {[
            ["Open alerts", "1", "bg-caution"],
            ["Within limits", "2/3", "bg-caution"],
            ["Dose rate", "82", "bg-ok"],
            ["Loudest", "67.7", "bg-caution"],
          ].map(([l, v, bar]) => (
            <div key={l} className="relative overflow-hidden rounded-lg border border-border bg-background/60 p-2">
              <span className={`absolute inset-y-0 left-0 w-0.5 ${bar}`} />
              <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{l}</p>
              <p className="text-lg font-semibold">{v}</p>
            </div>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {crew.map((c) => (
            <div key={c.cs} className={`rounded-lg border bg-background/60 p-2 ${c.tone === "caution" ? "border-caution/50" : "border-border"}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold">{c.cs}</span>
                <span className={`rounded-full px-1.5 text-[9px] ${c.tone === "caution" ? "bg-caution/15 text-caution" : "bg-ok/15 text-ok"}`}>{c.label}</span>
              </div>
              <p className={`mt-1 text-xl font-semibold ${c.hr > 110 ? "text-caution" : ""}`}>
                {c.hr}
                <span className="ml-0.5 text-[9px] font-normal text-muted-foreground">bpm</span>
              </p>
              <svg viewBox="0 0 100 24" className="h-6 w-full text-series" preserveAspectRatio="none">
                <polyline
                  points={Array.from({ length: 20 }, (_, i) => `${i * 5.26},${12 + Math.sin(i / 2 + c.hr) * 6 - (c.hr > 110 ? i * 0.3 : 0)}`).join(" ")}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              <p className="text-[9px] text-muted-foreground">SpO₂ {c.spo2}%</p>
            </div>
          ))}
        </div>
        <div className="mt-2 flex items-center gap-2 rounded-lg border border-caution/40 bg-caution/10 px-2 py-1.5 text-[10px] text-caution">
          <LineChart className="size-3" /> Heart rate rising, reaches caution (110 bpm) in about 7 min
        </div>
      </div>
      <p className="mt-3 text-center text-xs text-muted-foreground">Illustration of the crew dashboard</p>
    </div>
  );
}

export default async function Home() {
  const signedIn = (await cookies()).getAll().some((c) => c.name.startsWith(AUTH_COOKIE_NAME));
  const demo = demoLogin() !== null;
  const primary = signedIn
    ? { href: "/dashboard", label: "Open dashboard" }
    : demo
      ? { href: "/dashboard", label: "Open the live dashboard" }
      : { href: "/login", label: "Crew sign in" };

  return (
    <div className="min-h-dvh overflow-x-clip">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <span className="flex items-center gap-2">
          <span className="flex size-8 items-center justify-center rounded-lg bg-info/15 ring-1 ring-info/30">
            <Activity className="size-5 text-info" aria-hidden />
          </span>
          <span className="font-semibold tracking-[0.25em]">OMNI</span>
        </span>
        <Link prefetch={false} href={primary.href} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-muted">
          {signedIn || demo ? "Dashboard" : "Sign in"}
        </Link>
      </header>

      <main>
        <section className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-16 pt-8 lg:grid-cols-2 lg:pt-16">
          <div className="flex flex-col gap-6">
            <p className="w-fit rounded-full border border-info/40 bg-info/10 px-3 py-1 text-xs font-medium text-info">Ambient crew health monitoring</p>
            <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl lg:text-6xl">
              Keeping the crew healthy, <span className="bg-gradient-to-r from-info to-ok bg-clip-text text-transparent">millions of km from a doctor.</span>
            </h1>
            <p className="max-w-xl text-lg text-muted-foreground">
              OMNI watches vitals, radiation, cabin air and noise aboard a deep-space spacecraft, warns early, guides the crew through emergencies, and keeps
              working when the link to Earth is down for hours.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Link
                prefetch={false}
                href={primary.href}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-3 font-semibold text-primary-foreground shadow-lg shadow-info/10 hover:bg-primary/90"
              >
                {primary.label} <ArrowRight className="size-4" aria-hidden />
              </Link>
              <a href="#how" className="rounded-lg border border-border px-5 py-3 font-medium hover:bg-muted">
                How it works
              </a>
            </div>
            {demo && !signedIn && <p className="text-sm text-muted-foreground">No sign-in needed: you join a simulated crew as the mission commander.</p>}
          </div>
          <Preview />
        </section>

        <section aria-labelledby="features-heading" className="border-y border-border/60 bg-card/30">
          <div className="mx-auto max-w-6xl px-4 py-16">
            <h2 id="features-heading" className="text-3xl font-semibold tracking-tight">
              Everything the crew and flight surgeon need
            </h2>
            <p className="mt-2 max-w-2xl text-muted-foreground">One system aboard: from the heartbeat on a wrist sensor to the shift handover.</p>
            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FEATURES.map(({ icon: Icon, title, text }) => (
                <div key={title} className="rounded-xl border border-border/80 bg-gradient-to-b from-card to-card/60 p-5">
                  <span className="flex size-10 items-center justify-center rounded-lg bg-info/15 text-info">
                    <Icon className="size-5" aria-hidden />
                  </span>
                  <h3 className="mt-4 font-semibold">{title}</h3>
                  <p className="mt-1 text-sm text-muted-foreground">{text}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section id="how" aria-labelledby="how-heading" className="mx-auto max-w-6xl scroll-mt-8 px-4 py-16">
          <h2 id="how-heading" className="text-3xl font-semibold tracking-tight">
            Built for a spacecraft, not a data centre
          </h2>
          <p className="mt-2 max-w-2xl text-muted-foreground">Earth can be 20 light-minutes away and out of contact for hours. So OMNI lives aboard.</p>
          <ol className="mt-10 grid gap-4 lg:grid-cols-3">
            {[
              { n: 1, title: "Aboard", text: "Sensors, tablets and the station server keep every record, alert and procedure locally. Nothing waits for Earth." },
              { n: 2, title: "Uplink", text: "When the Deep Space Network link opens, a relay sends signed, compressed batches. Gaps and retries are expected, not errors." },
              { n: 3, title: "Mission Control", text: "Flight surgeons on Earth see the replicated data and send advice back up, which lands in the crew inbox." },
            ].map((s, i) => (
              <li key={s.n} className="relative rounded-xl border border-border/80 bg-card/60 p-5">
                <span className="flex size-8 items-center justify-center rounded-full bg-info text-sm font-bold text-background">{s.n}</span>
                <h3 className="mt-3 font-semibold">{s.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
                {i < 2 && <ArrowRight className="absolute -right-3 top-1/2 hidden size-6 -translate-y-1/2 text-border lg:block" aria-hidden />}
              </li>
            ))}
          </ol>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {PRINCIPLES.map(({ icon: Icon, title, text }) => (
              <div key={title} className="flex gap-3">
                <Icon className="mt-0.5 size-5 shrink-0 text-ok" aria-hidden />
                <div>
                  <h3 className="font-semibold">{title}</h3>
                  <p className="text-sm text-muted-foreground">{text}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-20">
          <div className="flex flex-col items-start gap-4 rounded-2xl border border-info/30 bg-gradient-to-r from-info/15 via-card to-ok/10 p-8 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-2xl font-semibold tracking-tight">See it with live data</h2>
              <p className="mt-1 text-muted-foreground">A simulated crew of three: vitals every minute, a radiation drill on demand.</p>
            </div>
            <Link prefetch={false} href={primary.href} className="inline-flex shrink-0 items-center gap-2 rounded-lg bg-primary px-5 py-3 font-semibold text-primary-foreground hover:bg-primary/90">
              {primary.label} <ArrowRight className="size-4" aria-hidden />
            </Link>
          </div>
        </section>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <ClipboardList className="size-3.5" aria-hidden /> OMNI ambient crew health monitoring
          </span>
          <span>Demo data is simulated. Not for clinical use.</span>
        </div>
      </footer>
    </div>
  );
}
