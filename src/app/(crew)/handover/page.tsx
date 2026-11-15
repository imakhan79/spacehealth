import { ClipboardList } from "lucide-react";
import Link from "next/link";
import { forecast } from "@/lib/dashboard/forecast";
import { summarizeMember, type MemberShift, type Point } from "@/lib/dashboard/handover";
import { getMe } from "@/lib/dashboard/me";
import { METRICS, type ChartedMetric } from "@/lib/dashboard/vital-thresholds";
import { createServerSupabase } from "@/lib/supabase/server";
import type { Tables } from "@/types/database.types";
import { cn } from "@/lib/utils";
import { PrintButton } from "./print-button";

export const dynamic = "force-dynamic";

const SHIFTS = [8, 12, 24] as const;

const fmtTime = (iso: string | number) => new Date(iso).toISOString().slice(11, 16) + "Z";
const fmtDuration = (ms: number) => {
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};
const pct = (x: number) => (x === 0 ? "—" : `${Math.max(1, Math.round(x * 100))}%`);

type Alert = Tables<"health_alerts">;
type Message = Tables<"ground_messages"> & { ground_message_reads: Pick<Tables<"ground_message_reads">, "crew_member_id" | "read_at">[] };

function outcome(a: Alert, callsign: (id: string | null) => string): string {
  switch (a.status) {
    case "active":
      return "OPEN: not yet acknowledged";
    case "acknowledged":
      return `Acknowledged by ${callsign(a.acknowledged_by)} at ${a.acknowledged_at ? fmtTime(a.acknowledged_at) : "?"}`;
    case "overridden":
      return `Overridden by ${callsign(a.overridden_by)}: “${a.override_reason ?? ""}”`;
    case "resolved":
      return `Resolved at ${a.resolved_at ? fmtTime(a.resolved_at) : "?"}`;
  }
}

export default async function HandoverPage({ searchParams }: { searchParams: Promise<{ hours?: string }> }) {
  const requested = Number((await searchParams).hours);
  const hours = SHIFTS.find((h) => h === requested) ?? 12;
  const me = await getMe();
  const now = Date.now();
  const from = now - hours * 3_600_000;
  const since = new Date(from).toISOString();

  let error: string | null = null;
  let crew: Pick<Tables<"crew_members">, "id" | "callsign" | "full_name" | "role">[] = [];
  let alerts: Alert[] = [];
  let messages: Message[] = [];
  const shifts = new Map<string, { summary: MemberShift; series: Partial<Record<ChartedMetric, Point[]>> }>();

  try {
    const db = await createServerSupabase();
    const crewRes = await db.from("crew_members").select("id, callsign, full_name, role").eq("is_active", true).neq("role", "sensor_gateway").order("callsign");
    if (crewRes.error) throw new Error(crewRes.error.message);
    crew = crewRes.data;

    // One request per member and metric keeps each under the 1,000-row cap.
    const metricKeys = [...METRICS.map((m) => m.key), "cumulative_radiation_dose"] as const;
    const [alertsRes, messagesRes, ...telemetry] = await Promise.all([
      db.from("health_alerts").select("*").or(`triggered_at.gte.${since},status.eq.active`).order("triggered_at", { ascending: false }).limit(200),
      db
        .from("ground_messages")
        .select("*, ground_message_reads(crew_member_id, read_at)")
        .gte("received_at", since)
        .order("received_at", { ascending: false })
        .limit(100),
      ...crew.flatMap((c) =>
        metricKeys.map((metric) =>
          db
            .from("crew_telemetry")
            .select("value, recorded_at")
            .eq("crew_member_id", c.id)
            .eq("metric", metric)
            .is("deleted_at", null)
            .gte("recorded_at", since)
            .order("recorded_at", { ascending: true })
            .limit(1000),
        ),
      ),
    ]);
    if (alertsRes.error) throw new Error(alertsRes.error.message);
    if (messagesRes.error) throw new Error(messagesRes.error.message);
    alerts = alertsRes.data;
    messages = messagesRes.data as Message[];

    crew.forEach((c, ci) => {
      const series: Partial<Record<ChartedMetric, Point[]>> = {};
      let dose: Point[] = [];
      metricKeys.forEach((metric, mi) => {
        const r = telemetry[ci * metricKeys.length + mi]!;
        if (r.error) throw new Error(r.error.message);
        const pts = r.data.map((row) => ({ t: Date.parse(row.recorded_at), v: row.value }));
        if (metric === "cumulative_radiation_dose") dose = pts;
        else series[metric] = pts;
      });
      // RLS limits ordinary crew to their own vitals; skip members we can't see.
      if (Object.values(series).some((s) => s.length > 0) || dose.length > 0)
        shifts.set(c.id, { summary: summarizeMember(series, dose, from, now), series });
    });
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  const byId = new Map(crew.map((c) => [c.id, c]));
  const callsign = (id: string | null) => (id ? (byId.get(id)?.callsign ?? "crew") : "crew");
  const open = alerts.filter((a) => a.status === "active");
  const inShift = alerts.filter((a) => Date.parse(a.triggered_at) >= from);
  const unreadByMe = messages.filter((m) => !m.ground_message_reads.some((r) => r.crew_member_id === me?.crewMemberId));

  return (
    <article className="mx-auto flex max-w-5xl flex-col gap-6 print:max-w-none print:text-black">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="flex items-center gap-2 text-2xl font-semibold">
          <ClipboardList className="size-6 text-info print:hidden" aria-hidden />
          Shift handover
        </h1>
        <nav aria-label="Shift length" className="flex rounded-md border border-border p-0.5 print:hidden">
          {SHIFTS.map((h) => (
            <Link
              key={h}
              href={`/handover?hours=${h}`}
              aria-current={h === hours ? "page" : undefined}
              className={cn("rounded px-3 py-1 text-sm", h === hours ? "bg-muted font-semibold" : "text-muted-foreground hover:text-foreground")}
            >
              {h} h
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex gap-2 print:hidden">
          <Link href="/dashboard" className="rounded-md border border-border px-3 py-2 text-sm hover:bg-muted">
            Back to dashboard
          </Link>
          <PrintButton />
        </div>
      </div>

      <p className="text-sm text-muted-foreground print:text-black">
        {hours} h ending {fmtTime(now)} on {new Date(now).toISOString().slice(0, 10)} · prepared for {me?.callsign ?? "crew"} · all times UTC
      </p>

      {error && <p className="rounded-md border border-emergency/40 bg-emergency/10 px-3 py-2 text-sm text-emergency">Couldn&apos;t load the report: {error}</p>}

      <section aria-labelledby="summary-heading" className="grid gap-3 sm:grid-cols-3">
        <h2 id="summary-heading" className="sr-only">
          Summary
        </h2>
        {[
          { label: "Open alerts", value: open.length, tone: open.length > 0 ? "text-warning" : "" },
          { label: "Alerts this shift", value: inShift.length, tone: "" },
          { label: "Unread messages (you)", value: unreadByMe.length, tone: unreadByMe.length > 0 ? "text-info" : "" },
        ].map((s) => (
          <div key={s.label} className="rounded-lg border border-border bg-card p-4 print:border-black print:bg-white">
            <div className="text-xs text-muted-foreground print:text-black">{s.label}</div>
            <div className={cn("text-3xl font-semibold", s.tone, "print:text-black")}>{s.value}</div>
          </div>
        ))}
      </section>

      <section aria-labelledby="crew-heading" className="flex flex-col gap-4">
        <h2 id="crew-heading" className="text-lg font-semibold">
          Crew
        </h2>
        {crew.filter((c) => shifts.has(c.id)).map((c) => {
          const { summary, series } = shifts.get(c.id)!;
          const warnings = METRICS.map((m) => forecast(m, series[m.key] ?? [], now)).filter((f) => f !== null);
          return (
            <div key={c.id} className="break-inside-avoid rounded-lg border border-border bg-card p-4 print:border-black print:bg-white">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-base font-semibold">
                  {c.callsign} <span className="font-normal text-muted-foreground print:text-black">{c.full_name}</span>
                </h3>
                <span className="text-xs text-muted-foreground print:text-black">
                  Longest data gap {fmtDuration(summary.longestGapMs)}
                  {summary.doseAddedMsv !== null &&
                    ` · dose +${summary.doseAddedMsv.toFixed(3)} mSv (total ${summary.doseLatestMsv!.toFixed(1)} mSv)`}
                </span>
              </div>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-sm tabular-nums">
                  <thead className="text-xs text-muted-foreground print:text-black">
                    <tr>
                      <th className="py-1 pr-3 font-medium">Vital</th>
                      <th className="py-1 pr-3 font-medium">Latest</th>
                      <th className="py-1 pr-3 font-medium">Min</th>
                      <th className="py-1 pr-3 font-medium">Median</th>
                      <th className="py-1 pr-3 font-medium">Max</th>
                      <th className="py-1 pr-3 font-medium">Time in caution</th>
                      <th className="py-1 font-medium">Time in emergency</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.metrics.map((s) => {
                      const spec = METRICS.find((m) => m.key === s.metric)!;
                      const f = (v: number | null) => (v === null ? "—" : `${v.toFixed(spec.digits)}`);
                      return (
                        <tr key={s.metric} className="border-t border-border print:border-black">
                          <td className="py-1 pr-3">
                            {spec.label} <span className="text-xs text-muted-foreground print:text-black">{spec.unit}</span>
                          </td>
                          <td className="py-1 pr-3 font-semibold">{f(s.latest)}</td>
                          <td className="py-1 pr-3">{f(s.min)}</td>
                          <td className="py-1 pr-3">{f(s.median)}</td>
                          <td className="py-1 pr-3">{f(s.max)}</td>
                          <td className={cn("py-1 pr-3", s.cautionShare > 0 && "text-caution print:text-black")}>{pct(s.cautionShare)}</td>
                          <td className={cn("py-1", s.emergencyShare > 0 && "font-semibold text-emergency print:text-black")}>{pct(s.emergencyShare)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {warnings.length > 0 && (
                <ul className="mt-2 flex flex-col gap-1 text-xs text-caution print:text-black">
                  {warnings.map((w) => {
                    const spec = METRICS.find((m) => m.key === w.metric)!;
                    return (
                      <li key={w.metric}>
                        Early warning: {spec.label} {w.direction}, reaches caution ({w.threshold} {spec.unit}) in about{" "}
                        {Math.max(1, Math.round(w.minutesToCross))} min
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          );
        })}
      </section>

      <section aria-labelledby="alerts-heading" className="flex flex-col gap-2">
        <h2 id="alerts-heading" className="text-lg font-semibold">
          Alerts
        </h2>
        {alerts.length === 0 ? (
          <p className="text-sm text-muted-foreground">No alerts this shift.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border print:border-black">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground print:text-black">
                <tr>
                  <th className="px-3 py-2 font-medium">Time</th>
                  <th className="px-3 py-2 font-medium">Crew</th>
                  <th className="px-3 py-2 font-medium">Severity</th>
                  <th className="px-3 py-2 font-medium">Alert</th>
                  <th className="px-3 py-2 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.id} className="border-t border-border align-top print:border-black">
                    <td className="px-3 py-2 tabular-nums">{fmtTime(a.triggered_at)}</td>
                    <td className="px-3 py-2">{callsign(a.crew_member_id)}</td>
                    <td className={cn("px-3 py-2 font-semibold uppercase", { emergency: "text-emergency", warning: "text-warning", caution: "text-caution", advisory: "text-info" }[a.severity], "print:text-black")}>
                      {a.severity}
                    </td>
                    <td className="px-3 py-2">{a.message}</td>
                    <td className={cn("px-3 py-2", a.status === "active" && "font-semibold")}>{outcome(a, callsign)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="msgs-heading" className="flex flex-col gap-2">
        <h2 id="msgs-heading" className="text-lg font-semibold">
          Messages from Mission Control
        </h2>
        {messages.length === 0 ? (
          <p className="text-sm text-muted-foreground">No messages this shift.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border print:border-black">
            <table className="w-full text-left text-sm">
              <thead className="text-xs text-muted-foreground print:text-black">
                <tr>
                  <th className="px-3 py-2 font-medium">Received</th>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 font-medium">To</th>
                  <th className="px-3 py-2 font-medium">Subject</th>
                  <th className="px-3 py-2 font-medium">Read by</th>
                </tr>
              </thead>
              <tbody>
                {messages.map((m) => (
                  <tr key={m.id} className="border-t border-border align-top print:border-black">
                    <td className="px-3 py-2 tabular-nums">{fmtTime(m.received_at)}</td>
                    <td className="px-3 py-2">{m.author}</td>
                    <td className="px-3 py-2">{m.recipient_crew_id ? callsign(m.recipient_crew_id) : "All crew"}</td>
                    <td className="px-3 py-2">
                      {m.priority === "urgent" && <span className="mr-1 font-semibold text-warning print:text-black">URGENT</span>}
                      {m.subject}
                    </td>
                    <td className="px-3 py-2">
                      {m.ground_message_reads.length === 0
                        ? "Nobody yet"
                        : m.ground_message_reads.map((r) => `${callsign(r.crew_member_id)} ${fmtTime(r.read_at)}`).join(", ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </article>
  );
}
