"use client";

import { Activity, Bike, Dumbbell, Footprints, Gauge, HeartHandshake, Package, Pill } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConnectivity } from "@/components/connectivity-provider";
import {
  WELLNESS_FLAG_TEXT,
  adherence,
  canLog,
  doseSlots,
  kitFlags,
  wellnessFlags,
  type KitFlag,
  type SlotStatus,
} from "@/lib/care";
import type { Me } from "@/lib/dashboard/types";
import { METRICS, toneOf, type Tone } from "@/lib/dashboard/vital-thresholds";
import { BAND_TEXT, readiness, type ReadinessBand } from "@/lib/readiness";
import type { Enums, Tables } from "@/types/database.types";
import { cn } from "@/lib/utils";

type Crew = Pick<Tables<"crew_members">, "id" | "callsign" | "full_name" | "role">;
interface CareData {
  crew: Crew[];
  checkins: Tables<"wellness_checkins">[];
  meds: Tables<"medications">[];
  doses: Tables<"medication_doses">[];
  kit: Tables<"medical_inventory">[];
  rx: Tables<"exercise_prescriptions">[];
  sessions: Tables<"exercise_sessions">[];
  vitals: Pick<Tables<"crew_telemetry">, "crew_member_id" | "metric" | "value" | "recorded_at">[];
  alerts: Pick<Tables<"health_alerts">, "crew_member_id" | "severity">[];
}

const REFRESH_MS = 30_000;
const SYMPTOMS = ["headache", "nausea", "congestion", "back_pain", "eye_strain", "insomnia", "dizziness", "skin_irritation"] as const;
const label = (s: string) => s.replace("_", " ").replace(/^./, (c) => c.toUpperCase());
const clock = (t: number | string) => new Date(t).toISOString().slice(11, 16) + "Z";
const DAY = 24 * 3_600_000;

export function CareClient({ me }: { me: Me | null }) {
  const { client } = useConnectivity();
  const [data, setData] = useState<CareData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const t = Date.now();
    const since14 = new Date(t - 13 * DAY).toISOString().slice(0, 10);
    const [crew, checkins, meds, doses, kit, rx, sessions, vitals, alerts] = await Promise.all([
      client.from("crew_members").select("id, callsign, full_name, role").eq("is_active", true).neq("role", "sensor_gateway").order("callsign"),
      client.from("wellness_checkins").select("*").gte("checkin_date", since14).order("checkin_date", { ascending: false }),
      client.from("medications").select("*").eq("active", true).order("name"),
      client.from("medication_doses").select("*").gte("due_at", new Date(t - 2 * DAY).toISOString()),
      client.from("medical_inventory").select("*").order("category").order("item"),
      client.from("exercise_prescriptions").select("*"),
      client.from("exercise_sessions").select("*").gte("performed_at", new Date(t - 7 * DAY).toISOString()).order("performed_at", { ascending: false }),
      client
        .from("crew_telemetry")
        .select("crew_member_id, metric, value, recorded_at")
        .in("metric", METRICS.map((m) => m.key))
        .gte("recorded_at", new Date(t - 10 * 60_000).toISOString())
        .order("recorded_at", { ascending: false })
        .limit(400),
      client.from("health_alerts").select("crew_member_id, severity").eq("status", "active"),
    ]);
    setNow(t);
    const failed = [crew, checkins, meds, doses, kit, rx, sessions, vitals, alerts].find((r) => r.error);
    if (failed) {
      setError("Station server not responding; showing the last data loaded.");
      return;
    }
    setError(null);
    setData({
      crew: crew.data ?? [],
      checkins: checkins.data ?? [],
      meds: meds.data ?? [],
      doses: doses.data ?? [],
      kit: kit.data ?? [],
      rx: rx.data ?? [],
      sessions: sessions.data ?? [],
      vitals: vitals.data ?? [],
      alerts: alerts.data ?? [],
    });
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const oversight = me?.role === "flight_surgeon" || me?.role === "commander";

  return (
    <div className="flex flex-col gap-8">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <HeartHandshake className="size-6 text-info" aria-hidden /> Crew care
      </h1>
      {error && <p className="rounded-md border border-caution/40 bg-caution/10 px-3 py-2 text-sm text-caution">{error}</p>}
      {data === null ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <ReadinessSection data={data} now={now} />
          <Wellness data={data} me={me} oversight={oversight} now={now} onSaved={load} />
          <Medications data={data} me={me} oversight={oversight} now={now} onChanged={load} />
          <Exercise data={data} me={me} oversight={oversight} now={now} onLogged={load} />
        </>
      )}
    </div>
  );
}

// --- readiness --------------------------------------------------------------------

const BAND_STYLE: Record<ReadinessBand, { badge: "ok" | "caution" | "warning"; text: string }> = {
  ready: { badge: "ok", text: "text-ok" },
  monitor: { badge: "caution", text: "text-caution" },
  review: { badge: "warning", text: "text-warning" },
};
const SEVERITY_ORDER = ["advisory", "caution", "warning", "emergency"] as const;

function ReadinessSection({ data, now }: { data: CareData; now: number }) {
  const today = new Date(now).toISOString().slice(0, 10);
  const scored = data.crew
    .map((c) => {
      const checkin = data.checkins.find((x) => x.crew_member_id === c.id && x.checkin_date === today) ?? null;
      const vitals = data.vitals.filter((v) => v.crew_member_id === c.id);
      if (!checkin && vitals.length === 0) return null; // RLS: not ours to see
      // Worst tone across each metric's newest sample.
      let vitalsTone: Tone | null = null;
      for (const m of METRICS) {
        const v = vitals.find((x) => x.metric === m.key);
        if (!v) continue;
        const t = toneOf(m, v.value);
        if (t === "emergency" || (t === "caution" && vitalsTone !== "emergency") || vitalsTone === null) vitalsTone = t;
      }
      const sev = data.alerts.filter((a) => a.crew_member_id === c.id).map((a) => a.severity);
      const openAlert = sev.length ? [...sev].sort((a, b) => SEVERITY_ORDER.indexOf(b) - SEVERITY_ORDER.indexOf(a))[0]! : null;
      const shares = (["treadmill", "resistance", "cycle"] as const)
        .map((k) => {
          const rx = data.rx.find((r) => r.crew_member_id === c.id && r.kind === k)?.weekly_minutes ?? 0;
          return adherence(data.sessions.filter((s) => s.crew_member_id === c.id && s.kind === k).map((s) => ({ minutes: s.minutes, performedAt: Date.parse(s.performed_at) })), rx, now).share;
        })
        .filter((x): x is number => x !== null);
      const missed = data.meds
        .filter((m) => m.crew_member_id === c.id)
        .flatMap((m) => doseSlots(m.schedule_utc.map((x) => x.slice(0, 5)), data.doses.filter((d) => d.medication_id === m.id).map((d) => ({ dueAt: Date.parse(d.due_at), takenAt: Date.parse(d.taken_at) })), now))
        .filter((sl) => sl.status === "missed").length;
      const r = readiness({
        checkin: checkin ? { sleep_hours: Number(checkin.sleep_hours), fatigue: checkin.fatigue, mood: checkin.mood, symptoms: checkin.symptoms } : null,
        vitalsTone,
        openAlert,
        exerciseShare: shares.length ? shares.reduce((a, b) => a + b, 0) / shares.length : null,
        missedDosesToday: missed,
      });
      return { member: c, r };
    })
    .filter((x) => x !== null);

  if (scored.length === 0) return null;
  return (
    <section aria-labelledby="readiness-heading" className="flex flex-col gap-3">
      <h2 id="readiness-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Gauge className="size-4 text-info" aria-hidden /> Readiness today
      </h2>
      <p className="text-sm text-muted-foreground">
        100 minus the listed deductions, from today&apos;s check-in, latest vitals, open alerts, exercise and doses. A prompt for a conversation, not a diagnosis.
      </p>
      <div className="grid gap-4 md:grid-cols-3">
        {scored.map(({ member, r }) => (
          <Card key={member.id}>
            <CardContent className="flex flex-col gap-2 p-4">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold">{member.callsign}</span>
                <Badge variant={BAND_STYLE[r.band].badge}>{BAND_TEXT[r.band]}</Badge>
              </div>
              <div className={cn("text-5xl font-semibold", BAND_STYLE[r.band].text)}>{r.score}</div>
              {r.deductions.length === 0 ? (
                <p className="text-xs text-muted-foreground">No deductions.</p>
              ) : (
                <ul className="flex flex-col gap-0.5 text-xs">
                  {r.deductions.map((d) => (
                    <li key={d.reason} className="flex justify-between gap-2">
                      <span className="text-muted-foreground">{d.reason}</span>
                      <span className="tabular-nums">−{d.points}</span>
                    </li>
                  ))}
                </ul>
              )}
              {r.incomplete && <p className="text-xs text-caution">No check-in today: scored on vitals, alerts, exercise and doses only.</p>}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}

// --- wellness ---------------------------------------------------------------------

function Scale({ name, value, onChange, low, high }: { name: string; value: number; onChange: (v: number) => void; low: string; high: string }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="text-sm">{name}</legend>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="w-16 text-right">{low}</span>
        <div role="radiogroup" aria-label={name} className="flex gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={value === n}
              onClick={() => onChange(n)}
              className={cn(
                "size-9 rounded-md border text-sm font-semibold",
                value === n ? "border-info bg-info/20 text-foreground" : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="w-16">{high}</span>
      </div>
    </fieldset>
  );
}

function Wellness({ data, me, oversight, now, onSaved }: { data: CareData; me: Me | null; oversight: boolean; now: number; onSaved: () => Promise<void> }) {
  const { client } = useConnectivity();
  const today = new Date(now).toISOString().slice(0, 10);
  const mine = data.checkins.filter((c) => c.crew_member_id === me?.crewMemberId);
  const todays = mine.find((c) => c.checkin_date === today);
  const [sleep, setSleep] = useState(todays ? Number(todays.sleep_hours) : 7);
  const [fatigue, setFatigue] = useState(todays?.fatigue ?? 2);
  const [mood, setMood] = useState(todays?.mood ?? 4);
  const [symptoms, setSymptoms] = useState<string[]>(todays?.symptoms.filter((s) => s !== "none") ?? []);
  const [note, setNote] = useState(todays?.note ?? "");
  const [status, setStatus] = useState<string | null>(null);

  async function save(): Promise<void> {
    if (client === null) return;
    setStatus("Saving…");
    const res = await client
      .from("wellness_checkins")
      .upsert(
        { sleep_hours: sleep, fatigue, mood, symptoms: symptoms.length ? symptoms : ["none"], note: note.trim() || null },
        { onConflict: "crew_member_id,checkin_date" },
      );
    setStatus(res.error ? `Couldn't save: ${res.error.message}` : "Saved for today.");
    await onSaved();
  }

  const history = [...mine].sort((a, b) => a.checkin_date.localeCompare(b.checkin_date));
  const maxSleep = 10;

  return (
    <section aria-labelledby="wellness-heading" className="flex flex-col gap-3">
      <h2 id="wellness-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Activity className="size-4 text-info" aria-hidden /> Daily wellness check-in
      </h2>
      <div className="grid gap-4 lg:grid-cols-2">
        {me?.crewMemberId && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-normal text-muted-foreground">
                {todays ? `You checked in today at ${clock(todays.updated_at)}; you can update it.` : "How are you today? Takes 20 seconds."}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <label className="flex items-center gap-3 text-sm">
                Sleep last night
                <input
                  type="number"
                  min={0}
                  max={16}
                  step={0.5}
                  value={sleep}
                  onChange={(e) => setSleep(Math.min(16, Math.max(0, Number(e.target.value))))}
                  className="h-9 w-20 rounded-md border border-border bg-background px-2 tabular-nums"
                />
                hours
              </label>
              <Scale name="Fatigue" value={fatigue} onChange={setFatigue} low="Rested" high="Exhausted" />
              <Scale name="Mood" value={mood} onChange={setMood} low="Very low" high="Very good" />
              <fieldset className="flex flex-col gap-1.5">
                <legend className="text-sm">Symptoms</legend>
                <div className="flex flex-wrap gap-1.5">
                  {SYMPTOMS.map((s) => {
                    const on = symptoms.includes(s);
                    return (
                      <button
                        key={s}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setSymptoms((all) => (on ? all.filter((x) => x !== s) : [...all, s]))}
                        className={cn("rounded-full border px-3 py-1 text-xs", on ? "border-caution bg-caution/15 text-caution" : "border-border text-muted-foreground hover:bg-muted")}
                      >
                        {label(s)}
                      </button>
                    );
                  })}
                </div>
              </fieldset>
              <label className="flex flex-col gap-1 text-sm">
                Note for the flight surgeon (optional)
                <textarea
                  value={note}
                  maxLength={500}
                  rows={2}
                  onChange={(e) => setNote(e.target.value)}
                  className="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                />
              </label>
              <div className="flex items-center gap-3">
                <Button onClick={() => void save()}>{todays ? "Update check-in" : "Check in"}</Button>
                {status && <span role="status" className="text-sm text-muted-foreground">{status}</span>}
              </div>
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Your sleep, last 14 days (6 h line = minimum target)</CardTitle>
          </CardHeader>
          <CardContent>
            {history.length === 0 ? (
              <p className="text-sm text-muted-foreground">No check-ins yet.</p>
            ) : (
              <>
                <div className="relative flex h-32 items-end gap-1 border-b border-border" role="img" aria-label={`Sleep hours: ${history.map((c) => `${c.checkin_date.slice(5)} ${c.sleep_hours} h`).join(", ")}`}>
                  <div className="pointer-events-none absolute inset-x-0 border-t border-muted-foreground/40" style={{ bottom: `${(6 / maxSleep) * 100}%` }} aria-hidden />
                  {history.map((c) => (
                    <div key={c.checkin_date} className="group relative flex h-full flex-1 items-end justify-center">
                      <div
                        title={`${c.checkin_date}: ${c.sleep_hours} h, fatigue ${c.fatigue}/5, mood ${c.mood}/5`}
                        className={cn("w-full max-w-6 rounded-t", Number(c.sleep_hours) < 6 ? "bg-caution" : "bg-series")}
                        style={{ height: `${Math.min(100, (Number(c.sleep_hours) / maxSleep) * 100)}%` }}
                      />
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex gap-1 text-[10px] text-muted-foreground tabular-nums">
                  {history.map((c) => (
                    <span key={c.checkin_date} className="flex-1 text-center">
                      {c.checkin_date.slice(8)}
                    </span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  <span className="mr-1 inline-block size-2.5 rounded-sm bg-series align-middle" aria-hidden /> 6 h or more
                  <span className="ml-3 mr-1 inline-block size-2.5 rounded-sm bg-caution align-middle" aria-hidden /> under 6 h
                </p>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {oversight && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Crew overview (medical oversight)</CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left text-sm tabular-nums">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-medium">Crew</th>
                  <th className="py-1 pr-3 font-medium">Sleep</th>
                  <th className="py-1 pr-3 font-medium">Fatigue</th>
                  <th className="py-1 pr-3 font-medium">Mood</th>
                  <th className="py-1 pr-3 font-medium">Symptoms</th>
                  <th className="py-1 font-medium">Needs attention</th>
                </tr>
              </thead>
              <tbody>
                {data.crew.map((c) => {
                  const theirs = data.checkins.filter((x) => x.crew_member_id === c.id);
                  const latest = theirs[0];
                  const flags = wellnessFlags(theirs.map((x) => ({ ...x, sleep_hours: Number(x.sleep_hours) })), now);
                  return (
                    <tr key={c.id} className="border-t border-border align-top">
                      <td className="py-1.5 pr-3 font-semibold">{c.callsign}</td>
                      <td className="py-1.5 pr-3">{latest ? `${latest.sleep_hours} h` : "—"}</td>
                      <td className="py-1.5 pr-3">{latest ? `${latest.fatigue}/5` : "—"}</td>
                      <td className="py-1.5 pr-3">{latest ? `${latest.mood}/5` : "—"}</td>
                      <td className="py-1.5 pr-3">{latest ? latest.symptoms.filter((s) => s !== "none").map(label).join(", ") || "None" : "—"}</td>
                      <td className="py-1.5">
                        {flags.length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <ul className="flex flex-col gap-0.5 text-caution">
                            {flags.map((f) => (
                              <li key={f}>{WELLNESS_FLAG_TEXT[f]}</li>
                            ))}
                          </ul>
                        )}
                        {latest?.note && <p className="mt-1 text-xs text-muted-foreground">“{latest.note}”</p>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </section>
  );
}

// --- medications & kit -----------------------------------------------------------

const SLOT_STYLE: Record<SlotStatus, string> = {
  taken: "border-ok/50 text-ok",
  due: "border-info bg-info/15 text-foreground",
  upcoming: "border-border text-muted-foreground",
  missed: "border-warning/60 bg-warning/10 text-warning",
};
const KIT_FLAG: Record<KitFlag, { text: string; variant: "emergency" | "warning" | "caution" }> = {
  expired: { text: "Expired", variant: "emergency" },
  out: { text: "Out of stock", variant: "emergency" },
  expiring: { text: "Expires soon", variant: "caution" },
  low: { text: "Low", variant: "warning" },
};

function Medications({ data, me, oversight, now, onChanged }: { data: CareData; me: Me | null; oversight: boolean; now: number; onChanged: () => Promise<void> }) {
  const { client } = useConnectivity();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const crewById = useMemo(() => new Map(data.crew.map((c) => [c.id, c])), [data.crew]);

  async function take(medId: string, dueAt: number): Promise<void> {
    if (client === null) return;
    setBusy(`${medId}@${dueAt}`);
    const res = await client.from("medication_doses").insert({ medication_id: medId, due_at: new Date(dueAt).toISOString() });
    setMsg(res.error ? `Couldn't log dose: ${res.error.message}` : null);
    await onChanged();
    setBusy(null);
  }

  async function use(itemId: string): Promise<void> {
    if (client === null) return;
    setBusy(itemId);
    const res = await client.rpc("use_medical_item", { p_item: itemId, p_count: 1 });
    setMsg(res.error ? `Couldn't update the kit: ${res.error.message}` : res.data === null ? "None left to take." : null);
    await onChanged();
    setBusy(null);
  }

  const medsByMember = data.crew
    .map((c) => ({ member: c, meds: data.meds.filter((m) => m.crew_member_id === c.id) }))
    .filter((g) => g.meds.length > 0 && (oversight || g.member.id === me?.crewMemberId));
  const flagged = data.kit.filter((i) => kitFlags(i, now).length > 0).length;

  return (
    <section aria-labelledby="meds-heading" className="flex flex-col gap-3">
      <h2 id="meds-heading" className="flex items-center gap-2 text-lg font-semibold">
        <Pill className="size-4 text-info" aria-hidden /> Medications & medical kit
      </h2>
      {msg && <p role="status" className="text-sm text-emergency">{msg}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-normal text-muted-foreground">Today&apos;s doses (UTC)</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {medsByMember.length === 0 && <p className="text-sm text-muted-foreground">No active medications.</p>}
            {medsByMember.map(({ member, meds }) => (
              <div key={member.id} className="flex flex-col gap-2">
                {oversight && <p className="text-sm font-semibold">{member.callsign}</p>}
                {meds.map((m) => {
                  const slots = doseSlots(m.schedule_utc.map((s) => s.slice(0, 5)), data.doses.filter((d) => d.medication_id === m.id).map((d) => ({ dueAt: Date.parse(d.due_at), takenAt: Date.parse(d.taken_at) })), now);
                  const own = m.crew_member_id === me?.crewMemberId;
                  return (
                    <div key={m.id} className="rounded-md border border-border p-3">
                      <div className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-semibold">{m.name}</span>
                        <span className="text-xs text-muted-foreground">{m.dose}</span>
                      </div>
                      {m.instructions && <p className="text-xs text-muted-foreground">{m.instructions}</p>}
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {slots.map((s) => (
                          <li key={s.dueAt} className={cn("flex items-center gap-2 rounded-md border px-2 py-1 text-xs", SLOT_STYLE[s.status])}>
                            <span className="font-semibold tabular-nums">{clock(s.dueAt)}</span>
                            <span>{s.status === "taken" ? `taken ${clock(s.takenAt!)}` : s.status}</span>
                            {own && canLog(s, now) && (
                              <Button size="sm" className="h-7 px-2" disabled={busy === `${m.id}@${s.dueAt}`} onClick={() => void take(m.id, s.dueAt)}>
                                {s.status === "missed" ? "Log late" : "Take"}
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-normal text-muted-foreground">
              <Package className="size-4" aria-hidden /> Medical kit · {flagged === 0 ? "all items OK" : `${flagged} item(s) need attention`}
            </CardTitle>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-2 font-medium">Item</th>
                  <th className="py-1 pr-2 font-medium">Stock</th>
                  <th className="py-1 pr-2 font-medium">Expires</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {data.kit.map((i) => {
                  const flags = kitFlags(i, now);
                  return (
                    <tr key={i.id} className="border-t border-border align-top">
                      <td className="py-1.5 pr-2">
                        {i.item}
                        <div className="text-xs text-muted-foreground">
                          {label(i.category)} · {i.location}
                          {i.updated_by && ` · last used by ${crewById.get(i.updated_by)?.callsign ?? "crew"}`}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-1">
                          {flags.map((f) => (
                            <Badge key={f} variant={KIT_FLAG[f].variant}>
                              {KIT_FLAG[f].text}
                            </Badge>
                          ))}
                        </div>
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums">
                        {i.quantity} <span className="text-xs text-muted-foreground">{i.unit}</span>
                        <div className="text-xs text-muted-foreground">min {i.min_quantity}</div>
                      </td>
                      <td className="py-1.5 pr-2 tabular-nums">{i.expires_on ?? "—"}</td>
                      <td className="py-1.5 text-right">
                        <Button size="sm" variant="outline" className="h-7 px-2" disabled={i.quantity === 0 || busy === i.id || !me?.crewMemberId} onClick={() => void use(i.id)}>
                          Use 1
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

// --- exercise --------------------------------------------------------------------

const KINDS: { kind: Enums<"exercise_kind">; label: string; icon: typeof Footprints }[] = [
  { kind: "treadmill", label: "Treadmill", icon: Footprints },
  { kind: "resistance", label: "Resistance", icon: Dumbbell },
  { kind: "cycle", label: "Cycle", icon: Bike },
];

function Ring({ share, met }: { share: number | null; met: boolean }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 72 72" className="size-20" aria-hidden>
      <circle cx="36" cy="36" r={r} fill="none" stroke="currentColor" strokeWidth="6" className="text-series/20" />
      <circle
        cx="36"
        cy="36"
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${(share ?? 0) * c} ${c}`}
        transform="rotate(-90 36 36)"
        className={met ? "text-ok" : "text-series"}
      />
      <text x="36" y="40" textAnchor="middle" className="fill-foreground text-[13px] font-semibold">
        {share === null ? "—" : `${Math.round(share * 100)}%`}
      </text>
    </svg>
  );
}

function Exercise({ data, me, oversight, now, onLogged }: { data: CareData; me: Me | null; oversight: boolean; now: number; onLogged: () => Promise<void> }) {
  const { client } = useConnectivity();
  const visible = data.crew.filter((c) => oversight || c.id === me?.crewMemberId);
  const [memberId, setMemberId] = useState<string | null>(null);
  const selected = memberId ?? me?.crewMemberId ?? visible[0]?.id ?? null;
  const [kind, setKind] = useState<Enums<"exercise_kind">>("treadmill");
  const [minutes, setMinutes] = useState(30);
  const [status, setStatus] = useState<string | null>(null);

  async function log(): Promise<void> {
    if (client === null) return;
    setStatus("Logging…");
    const res = await client.from("exercise_sessions").insert({ kind, minutes });
    setStatus(res.error ? `Couldn't log: ${res.error.message}` : `Logged ${minutes} min of ${kind}.`);
    await onLogged();
  }

  if (selected === null) return null;
  const sessions = data.sessions.filter((s) => s.crew_member_id === selected);

  return (
    <section aria-labelledby="exercise-heading" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="exercise-heading" className="flex items-center gap-2 text-lg font-semibold">
          <Dumbbell className="size-4 text-info" aria-hidden /> Exercise countermeasures
        </h2>
        {oversight && (
          <select value={selected} onChange={(e) => setMemberId(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2 text-sm" aria-label="Crew member">
            {visible.map((c) => (
              <option key={c.id} value={c.id}>
                {c.callsign}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="text-sm text-muted-foreground">Last 7 days against the weekly prescription. Exercise is what protects bone and muscle in microgravity.</p>
      <div className="grid gap-4 lg:grid-cols-3">
        {KINDS.map(({ kind: k, label: name, icon: Icon }) => {
          const rx = data.rx.find((r) => r.crew_member_id === selected && r.kind === k)?.weekly_minutes ?? 0;
          const a = adherence(
            sessions.filter((s) => s.kind === k).map((s) => ({ minutes: s.minutes, performedAt: Date.parse(s.performed_at) })),
            rx,
            now,
          );
          const met = a.share !== null && a.share >= 1;
          return (
            <Card key={k}>
              <CardContent className="flex items-center gap-4 p-4">
                <Ring share={a.share} met={met} />
                <div className="flex flex-col gap-0.5">
                  <span className="flex items-center gap-1.5 font-semibold">
                    <Icon className="size-4 text-muted-foreground" aria-hidden /> {name}
                  </span>
                  <span className="text-sm tabular-nums">
                    {a.minutes} / {a.prescribed} min
                  </span>
                  <span className={cn("text-xs", met ? "text-ok" : "text-muted-foreground")}>
                    {a.share === null ? "Not prescribed" : met ? "Weekly target met" : `${Math.max(0, a.prescribed - a.minutes)} min to go`}
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
      {selected === me?.crewMemberId && (
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3 p-4">
            <label className="flex flex-col gap-1 text-sm">
              Exercise
              <select value={kind} onChange={(e) => setKind(e.target.value as Enums<"exercise_kind">)} className="h-9 rounded-md border border-border bg-background px-2">
                {KINDS.map((k) => (
                  <option key={k.kind} value={k.kind}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Minutes
              <input type="number" min={1} max={240} value={minutes} onChange={(e) => setMinutes(Math.min(240, Math.max(1, Number(e.target.value))))} className="h-9 w-24 rounded-md border border-border bg-background px-2 tabular-nums" />
            </label>
            <Button onClick={() => void log()}>Log session</Button>
            {status && <span role="status" className="text-sm text-muted-foreground">{status}</span>}
          </CardContent>
        </Card>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">Sessions this week ({sessions.length})</summary>
        <ul className="mt-2 flex flex-col gap-1">
          {sessions.map((s) => (
            <li key={s.id} className="flex gap-3 tabular-nums">
              <span className="text-muted-foreground">{new Date(s.performed_at).toISOString().slice(5, 16).replace("T", " ")}Z</span>
              <span>{label(s.kind)}</span>
              <span>{s.minutes} min</span>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
