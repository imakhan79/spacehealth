"use client";

import { Check, CircleAlert, Play, Siren, Timer, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConnectivity } from "@/components/connectivity-provider";
import type { Me } from "@/lib/dashboard/types";
import { PROTOCOLS, missingCritical, protocolById, type Protocol } from "@/lib/procedures";
import type { Tables } from "@/types/database.types";
import { Ago } from "@/lib/use-now";
import { cn } from "@/lib/utils";

type Run = Tables<"procedure_runs">;
type Step = Tables<"procedure_steps">;
type Crew = Pick<Tables<"crew_members">, "id" | "callsign">;

const REFRESH_MS = 5_000; // others may be ticking steps on the same run
const clock = (t: string | number) => new Date(t).toISOString().slice(11, 19) + "Z";

export function ProceduresClient({ me }: { me: Me | null }) {
  const { client } = useConnectivity();
  const [crew, setCrew] = useState<Crew[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    if (client === null) return;
    const [c, r, st] = await Promise.all([
      client.from("crew_members").select("id, callsign").eq("is_active", true).neq("role", "sensor_gateway").order("callsign"),
      client.from("procedure_runs").select("*").order("started_at", { ascending: false }).limit(30),
      client.from("procedure_steps").select("*").gte("done_at", new Date(Date.now() - 7 * 86_400_000).toISOString()),
    ]);
    setLoaded(true);
    if (c.error || r.error || st.error) {
      setError("Station server not responding; showing the last data loaded.");
      return;
    }
    setError(null);
    setCrew(c.data ?? []);
    setRuns(r.data ?? []);
    setSteps(st.data ?? []);
  }, [client]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const callsign = useMemo(() => new Map(crew.map((c) => [c.id, c.callsign])), [crew]);
  const active = runs.filter((r) => r.outcome === "in_progress");
  const done = runs.filter((r) => r.outcome !== "in_progress");

  async function start(protocol: string, patient: string): Promise<void> {
    if (client === null) return;
    const res = await client.from("procedure_runs").insert({ protocol, patient_crew_id: patient });
    if (res.error) setError(`Couldn't start: ${res.error.message}`);
    await load();
  }

  return (
    <div className="flex flex-col gap-6">
      <h1 className="flex items-center gap-2 text-2xl font-semibold">
        <Siren className="size-6 text-emergency" aria-hidden /> Emergency procedures
      </h1>
      <p className="text-sm text-muted-foreground">
        Guided protocols with every step recorded: who did it and when. Training-grade outlines for this demo; a real mission uses its flight surgeons&apos;
        approved procedures.
      </p>
      {error && <p className="text-sm text-caution">{error}</p>}

      {active.map((run) => (
        <ActiveRun key={run.id} run={run} steps={steps.filter((s) => s.run_id === run.id)} callsign={callsign} canAct={!!me?.crewMemberId} onChanged={load} />
      ))}

      <section aria-labelledby="protocols-heading" className="flex flex-col gap-3">
        <h2 id="protocols-heading" className="text-lg font-semibold">
          Start a procedure
        </h2>
        <div className="grid gap-4 md:grid-cols-2">
          {PROTOCOLS.map((p) => (
            <ProtocolCard key={p.id} protocol={p} crew={crew} me={me} onStart={start} disabled={!loaded || !me?.crewMemberId} />
          ))}
        </div>
      </section>

      <section aria-labelledby="history-heading" className="flex flex-col gap-2">
        <h2 id="history-heading" className="text-lg font-semibold">
          Recent runs
        </h2>
        {done.length === 0 ? (
          <p className="text-sm text-muted-foreground">No finished runs.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Started</th>
                  <th className="px-3 py-2 font-medium">Procedure</th>
                  <th className="px-3 py-2 font-medium">Patient</th>
                  <th className="px-3 py-2 font-medium">Outcome</th>
                  <th className="px-3 py-2 font-medium">Steps done</th>
                  <th className="px-3 py-2 font-medium">Notes</th>
                </tr>
              </thead>
              <tbody>
                {done.map((r) => {
                  const p = protocolById(r.protocol);
                  return (
                    <tr key={r.id} className="border-t border-border align-top">
                      <td className="px-3 py-1.5 tabular-nums">{new Date(r.started_at).toISOString().slice(5, 16).replace("T", " ")}Z</td>
                      <td className="px-3 py-1.5">{p?.title ?? r.protocol}</td>
                      <td className="px-3 py-1.5">{callsign.get(r.patient_crew_id) ?? "crew"}</td>
                      <td className="px-3 py-1.5">
                        <Badge variant={r.outcome === "completed" ? "ok" : "neutral"}>{r.outcome}</Badge>
                        <div className="text-xs text-muted-foreground">
                          by {callsign.get(r.ended_by ?? "") ?? "crew"} · {r.ended_at ? Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60_000) : "?"} min
                        </div>
                      </td>
                      <td className="px-3 py-1.5 tabular-nums">
                        {steps.filter((s) => s.run_id === r.id).length}/{p?.steps.length ?? "?"}
                      </td>
                      <td className="px-3 py-1.5 text-muted-foreground">{r.notes ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function ProtocolCard({ protocol, crew, me, onStart, disabled }: { protocol: Protocol; crew: Crew[]; me: Me | null; onStart: (p: string, patient: string) => Promise<void>; disabled: boolean }) {
  const [patient, setPatient] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const chosen = patient || me?.crewMemberId || crew[0]?.id || "";
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{protocol.title}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{protocol.summary}</p>
        <p className="text-xs text-muted-foreground">
          {protocol.steps.length} steps · {protocol.steps.filter((s) => s.critical).length} critical
          {protocol.steps.some((s) => s.timerSec) && " · timed"}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Patient</span>
            <select value={chosen} onChange={(e) => setPatient(e.target.value)} className="h-9 rounded-md border border-border bg-background px-2">
              {crew.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.callsign}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="destructive"
            disabled={disabled || busy || !chosen}
            onClick={async () => {
              setBusy(true);
              await onStart(protocol.id, chosen);
              setBusy(false);
            }}
          >
            <Play aria-hidden /> {busy ? "Starting…" : "Start"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function Countdown({ seconds }: { seconds: number }) {
  const [endsAt, setEndsAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (endsAt === null) return;
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, [endsAt]);
  if (endsAt === null)
    return (
      <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => { setEndsAt(Date.now() + seconds * 1000); setNow(Date.now()); }}>
        <Timer aria-hidden /> {Math.round(seconds / 60)} min timer
      </Button>
    );
  const left = Math.max(0, Math.ceil((endsAt - now) / 1000));
  return (
    <span role="timer" aria-live="polite" className={cn("rounded-md border px-2 py-0.5 text-xs font-semibold tabular-nums", left === 0 ? "border-warning text-warning" : "border-info text-info")}>
      {left === 0 ? "Time's up" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
    </span>
  );
}

function ActiveRun({ run, steps, callsign, canAct, onChanged }: { run: Run; steps: Step[]; callsign: Map<string, string>; canAct: boolean; onChanged: () => Promise<void> }) {
  const { client } = useConnectivity();
  const protocol = protocolById(run.protocol);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!protocol) return null;
  const doneNos = steps.map((s) => s.step_no);
  const missing = missingCritical(protocol, doneNos);

  async function tick(stepNo: number): Promise<void> {
    if (client === null) return;
    setBusy(`s${stepNo}`);
    const res = await client.from("procedure_steps").upsert({ run_id: run.id, step_no: stepNo }, { onConflict: "run_id,step_no", ignoreDuplicates: true });
    setMsg(res.error ? res.error.message : null);
    await onChanged();
    setBusy(null);
  }

  async function end(outcome: "completed" | "aborted"): Promise<void> {
    if (client === null) return;
    setBusy(outcome);
    const res = await client.from("procedure_runs").update({ outcome, notes: notes.trim() || null }).eq("id", run.id);
    setMsg(res.error ? res.error.message : null);
    await onChanged();
    setBusy(null);
  }

  return (
    <section aria-label={`${protocol.title} in progress`} className="rounded-lg border-2 border-emergency bg-emergency/5 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-emergency">
          <CircleAlert className="size-5" aria-hidden /> {protocol.title} · patient {callsign.get(run.patient_crew_id) ?? "crew"}
        </h2>
        <span className="text-xs text-muted-foreground">
          started by {callsign.get(run.started_by) ?? "crew"} · {clock(run.started_at)} (<Ago iso={run.started_at} />)
        </span>
      </div>
      <ol className="mt-3 flex flex-col gap-2">
        {protocol.steps.map((step, i) => {
          const n = i + 1;
          const rec = steps.find((s) => s.step_no === n);
          return (
            <li key={n} className={cn("flex flex-wrap items-center gap-3 rounded-md border px-3 py-2", rec ? "border-ok/40 bg-ok/5" : "border-border bg-card")}>
              <span className="w-6 text-sm font-semibold tabular-nums text-muted-foreground">{n}.</span>
              <span className={cn("min-w-0 flex-1 text-sm", rec && "text-muted-foreground")}>
                {step.text}
                {step.critical && <span className="ml-2 text-xs font-semibold text-emergency">critical</span>}
              </span>
              {step.timerSec && !rec && <Countdown seconds={step.timerSec} />}
              {rec ? (
                <span className="flex items-center gap-1 text-xs text-ok">
                  <Check className="size-3.5" aria-hidden /> {callsign.get(rec.done_by) ?? "crew"} · {clock(rec.done_at)}
                </span>
              ) : (
                <Button size="sm" className="h-8" disabled={!canAct || busy === `s${n}`} onClick={() => void tick(n)}>
                  <Check aria-hidden /> Done
                </Button>
              )}
            </li>
          );
        })}
      </ol>
      <div className="mt-3 flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-sm">
          Notes (saved when the run ends)
          <textarea rows={2} maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button disabled={!canAct || missing.length > 0 || busy !== null} onClick={() => void end("completed")}>
            <Check aria-hidden /> Complete
          </Button>
          <Button variant="outline" disabled={!canAct || busy !== null} onClick={() => void end("aborted")}>
            <X aria-hidden /> Abort
          </Button>
          {missing.length > 0 && <span className="text-xs text-muted-foreground">Critical steps still open: {missing.join(", ")}</span>}
          {msg && <span className="text-xs text-emergency">{msg}</span>}
        </div>
      </div>
    </section>
  );
}
