"use client";

import { AlertTriangle, Dumbbell, History, Mail, Pill, Siren, SmilePlus, type LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useConnectivity } from "@/components/connectivity-provider";
import { protocolById } from "@/lib/procedures";
import { buildTimeline, filterTimeline, type EventKind, type TimelineEvent } from "@/lib/timeline";
import { cn } from "@/lib/utils";
import { outageNotice, readPageCache, savePageCache } from "@/lib/offline/page-cache";

const KINDS: { kind: EventKind; label: string; icon: LucideIcon }[] = [
  { kind: "alert", label: "Alerts", icon: AlertTriangle },
  { kind: "procedure", label: "Procedures", icon: Siren },
  { kind: "dose", label: "Doses", icon: Pill },
  { kind: "exercise", label: "Exercise", icon: Dumbbell },
  { kind: "checkin", label: "Check-ins", icon: SmilePlus },
  { kind: "message", label: "Messages", icon: Mail },
];
const TONE_TEXT: Record<TimelineEvent["tone"], string> = {
  normal: "text-muted-foreground",
  info: "text-info",
  caution: "text-caution",
  warning: "text-warning",
  emergency: "text-emergency",
};
const HOURS = 48;
const REFRESH_MS = 30_000;

export function TimelineClient() {
  const { client } = useConnectivity();
  const [events, setEvents] = useState<TimelineEvent[] | null>(null);
  const [crew, setCrew] = useState<{ id: string; callsign: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [crewId, setCrewId] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Set<EventKind>>(() => new Set(KINDS.map((k) => k.kind)));
  const [query, setQuery] = useState("");

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const since = new Date(Date.now() - HOURS * 3_600_000).toISOString();
    const [c, alerts, doses, meds, sessions, checkins, messages, runs] = await Promise.all([
      client.from("crew_members").select("id, callsign").eq("is_active", true).neq("role", "sensor_gateway").order("callsign"),
      client
        .from("health_alerts")
        .select("id, crew_member_id, severity, status, message, triggered_at, acknowledged_by, acknowledged_at, overridden_by, overridden_at, override_reason, resolved_at")
        .gte("triggered_at", since)
        .limit(300),
      client.from("medication_doses").select("id, crew_member_id, medication_id, due_at, taken_at").gte("taken_at", since).limit(500),
      client.from("medications").select("id, name"),
      client.from("exercise_sessions").select("id, crew_member_id, kind, minutes, performed_at").gte("performed_at", since).limit(300),
      client.from("wellness_checkins").select("id, crew_member_id, sleep_hours, fatigue, mood, updated_at").gte("updated_at", since).limit(200),
      client.from("ground_messages").select("id, author, subject, priority, recipient_crew_id, received_at").gte("received_at", since).limit(200),
      client.from("procedure_runs").select("id, protocol, patient_crew_id, started_by, started_at, outcome, ended_at, ended_by").gte("started_at", since).limit(100),
    ]);
    if ([c, alerts, doses, meds, sessions, checkins, messages, runs].some((r) => r.error)) {
      const cached = readPageCache<{ crew: typeof crew; events: TimelineEvent[] }>("timeline");
      if (cached) {
        setCrew((x) => (x.length ? x : cached.data.crew));
        setEvents((x) => x ?? cached.data.events);
      }
      setError(outageNotice(cached?.at ?? null));
      return;
    }
    setError(null);
    setCrew(c.data ?? []);
    const built = buildTimeline({
        alerts: alerts.data ?? [],
        doses: doses.data ?? [],
        medNames: new Map((meds.data ?? []).map((m) => [m.id, m.name])),
        sessions: sessions.data ?? [],
        checkins: (checkins.data ?? []).map((x) => ({ ...x, sleep_hours: Number(x.sleep_hours) })),
        messages: messages.data ?? [],
        runs: runs.data ?? [],
        protocolTitle: (id) => protocolById(id)?.title ?? id,
      });
    setEvents(built);
    savePageCache("timeline", { crew: c.data ?? [], events: built });
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const callsign = useMemo(() => new Map(crew.map((c) => [c.id, c.callsign])), [crew]);
  const who = useCallback((e: TimelineEvent) => {
    const subject = e.crewId ? (callsign.get(e.crewId) ?? "crew") : e.kind === "message" ? "all crew" : null;
    const actor = e.actorId && e.actorId !== e.crewId ? callsign.get(e.actorId) : null;
    return [subject, actor ? `by ${actor}` : null].filter(Boolean).join(" · ");
  }, [callsign]);
  const label = useCallback((e: TimelineEvent) => `${e.title} ${e.detail ?? ""} ${who(e)}`, [who]);
  const shown = useMemo(() => (events ? filterTimeline(events, { crewId, kinds, query }, label) : []), [events, crewId, kinds, query, label]);

  const byDay = new Map<string, TimelineEvent[]>();
  for (const e of shown) {
    const day = new Date(e.at).toISOString().slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), e]);
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <History className="size-6 text-info" aria-hidden /> Mission timeline
      </h1>
      <p className="text-sm text-muted-foreground">Everything recorded aboard in the last {HOURS} hours, newest first. Times are UTC.</p>

      {/* One row of filters, scoping the whole list. */}
      <div className="flex flex-wrap items-center gap-2">
        <select value={crewId ?? ""} onChange={(e) => setCrewId(e.target.value || null)} className="h-9 rounded-md border border-border bg-background px-2 text-sm" aria-label="Crew member">
          <option value="">All crew</option>
          {crew.map((c) => (
            <option key={c.id} value={c.id}>
              {c.callsign}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Event types">
          {KINDS.map(({ kind, label: name, icon: Icon }) => {
            const on = kinds.has(kind);
            return (
              <button
                key={kind}
                aria-pressed={on}
                onClick={() =>
                  setKinds((all) => {
                    const next = new Set(all);
                    if (on) next.delete(kind);
                    else next.add(kind);
                    return next;
                  })
                }
                className={cn("flex items-center gap-1 rounded-full border px-3 py-1 text-xs", on ? "border-info bg-info/15 text-foreground" : "border-border text-muted-foreground")}
              >
                <Icon className="size-3.5" aria-hidden /> {name}
              </button>
            );
          })}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search…"
          aria-label="Search the timeline"
          className="h-9 min-w-40 flex-1 rounded-md border border-border bg-background px-3 text-sm"
        />
      </div>

      {error && <p className="text-sm text-caution">{error}</p>}
      {events === null ? (
        !error && <p className="text-sm text-muted-foreground">Loading…</p>
      ) : shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing matches these filters.</p>
      ) : (
        <p className="text-xs text-muted-foreground">{shown.length} events</p>
      )}

      {[...byDay.entries()].map(([day, list]) => (
        <section key={day} aria-label={day} className="flex flex-col gap-1">
          <h2 className="sticky top-16 z-[1] bg-background/95 py-1 text-sm font-semibold text-muted-foreground backdrop-blur">{day}</h2>
          <ol className="flex flex-col border-l border-border">
            {list.map((e) => {
              const Icon = KINDS.find((k) => k.kind === e.kind)!.icon;
              return (
                <li key={e.id} className="relative flex gap-3 py-2 pl-5">
                  <span className={cn("absolute -left-2.5 top-2.5 flex size-5 items-center justify-center rounded-full border border-border bg-background", TONE_TEXT[e.tone])}>
                    <Icon className="size-3" aria-hidden />
                  </span>
                  <time className="w-12 shrink-0 pt-0.5 text-xs tabular-nums text-muted-foreground" dateTime={new Date(e.at).toISOString()}>
                    {new Date(e.at).toISOString().slice(11, 16)}
                  </time>
                  <div className="min-w-0">
                    <p className={cn("text-sm font-medium", e.tone === "normal" ? "text-foreground" : TONE_TEXT[e.tone])}>{e.title}</p>
                    {e.detail && <p className="text-sm text-muted-foreground">{e.detail}</p>}
                    {who(e) && <p className="text-xs text-muted-foreground">{who(e)}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}
