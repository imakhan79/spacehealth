// One timeline from every record aboard. Pure: callers pass rows in, get
// sorted, typed events out, then filter.

export type EventKind = "alert" | "dose" | "exercise" | "checkin" | "message" | "procedure";

export interface TimelineEvent {
  id: string;
  at: number;
  kind: EventKind;
  /** Crew member the event is about (patient, alert subject, etc.), if any. */
  crewId: string | null;
  /** Crew member who did it, if different and known. */
  actorId: string | null;
  title: string;
  detail: string | null;
  tone: "normal" | "info" | "caution" | "warning" | "emergency";
}

interface Alert {
  id: string;
  crew_member_id: string;
  severity: "advisory" | "caution" | "warning" | "emergency";
  status: string;
  message: string;
  triggered_at: string;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  overridden_by: string | null;
  overridden_at: string | null;
  override_reason: string | null;
  resolved_at: string | null;
}

export interface TimelineSources {
  alerts: Alert[];
  doses: { id: string; crew_member_id: string; medication_id: string; due_at: string; taken_at: string }[];
  medNames: Map<string, string>;
  sessions: { id: string; crew_member_id: string; kind: string; minutes: number; performed_at: string }[];
  checkins: { id: string; crew_member_id: string; sleep_hours: number; fatigue: number; mood: number; updated_at: string }[];
  messages: { id: string; author: string; subject: string; priority: string; recipient_crew_id: string | null; received_at: string }[];
  runs: { id: string; protocol: string; patient_crew_id: string; started_by: string; started_at: string; outcome: string; ended_at: string | null; ended_by: string | null }[];
  protocolTitle: (id: string) => string;
}

const SEVERITY_TONE = { advisory: "info", caution: "caution", warning: "warning", emergency: "emergency" } as const;

export function buildTimeline(s: TimelineSources): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  for (const a of s.alerts) {
    out.push({ id: `a:${a.id}`, at: Date.parse(a.triggered_at), kind: "alert", crewId: a.crew_member_id, actorId: null, title: `${a.severity.toUpperCase()} alert`, detail: a.message, tone: SEVERITY_TONE[a.severity] });
    if (a.acknowledged_at)
      out.push({ id: `a:${a.id}:ack`, at: Date.parse(a.acknowledged_at), kind: "alert", crewId: a.crew_member_id, actorId: a.acknowledged_by, title: "Alert acknowledged", detail: a.message, tone: "normal" });
    if (a.overridden_at)
      out.push({ id: `a:${a.id}:ovr`, at: Date.parse(a.overridden_at), kind: "alert", crewId: a.crew_member_id, actorId: a.overridden_by, title: "Alert overridden", detail: a.override_reason, tone: "normal" });
    if (a.resolved_at)
      out.push({ id: `a:${a.id}:res`, at: Date.parse(a.resolved_at), kind: "alert", crewId: a.crew_member_id, actorId: null, title: "Alert resolved", detail: a.message, tone: "normal" });
  }
  for (const d of s.doses) {
    const late = Date.parse(d.taken_at) - Date.parse(d.due_at) > 2 * 3_600_000;
    out.push({ id: `d:${d.id}`, at: Date.parse(d.taken_at), kind: "dose", crewId: d.crew_member_id, actorId: null, title: `Took ${s.medNames.get(d.medication_id) ?? "medication"}${late ? " (late)" : ""}`, detail: null, tone: late ? "caution" : "normal" });
  }
  for (const x of s.sessions)
    out.push({ id: `e:${x.id}`, at: Date.parse(x.performed_at), kind: "exercise", crewId: x.crew_member_id, actorId: null, title: `${x.kind[0]!.toUpperCase()}${x.kind.slice(1)} ${x.minutes} min`, detail: null, tone: "normal" });
  for (const c of s.checkins)
    out.push({ id: `c:${c.id}`, at: Date.parse(c.updated_at), kind: "checkin", crewId: c.crew_member_id, actorId: null, title: "Wellness check-in", detail: `Slept ${c.sleep_hours} h · fatigue ${c.fatigue}/5 · mood ${c.mood}/5`, tone: c.sleep_hours < 6 || c.fatigue >= 4 || c.mood <= 2 ? "caution" : "normal" });
  for (const m of s.messages)
    out.push({ id: `m:${m.id}`, at: Date.parse(m.received_at), kind: "message", crewId: m.recipient_crew_id, actorId: null, title: `Message from ${m.author}`, detail: m.subject, tone: m.priority === "urgent" ? "warning" : "info" });
  for (const r of s.runs) {
    out.push({ id: `p:${r.id}`, at: Date.parse(r.started_at), kind: "procedure", crewId: r.patient_crew_id, actorId: r.started_by, title: `Procedure started: ${s.protocolTitle(r.protocol)}`, detail: null, tone: "warning" });
    if (r.ended_at)
      out.push({ id: `p:${r.id}:end`, at: Date.parse(r.ended_at), kind: "procedure", crewId: r.patient_crew_id, actorId: r.ended_by, title: `Procedure ${r.outcome}: ${s.protocolTitle(r.protocol)}`, detail: null, tone: "normal" });
  }
  return out.filter((e) => Number.isFinite(e.at)).sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
}

export interface TimelineFilter {
  crewId: string | null;
  kinds: Set<EventKind>;
  query: string;
}

/** Crew filter matches the subject or the actor; messages to all crew match everyone. */
export function filterTimeline(events: TimelineEvent[], f: TimelineFilter, label: (e: TimelineEvent) => string): TimelineEvent[] {
  const q = f.query.trim().toLowerCase();
  return events.filter(
    (e) =>
      f.kinds.has(e.kind) &&
      (f.crewId === null || e.crewId === f.crewId || e.actorId === f.crewId || (e.kind === "message" && e.crewId === null)) &&
      (q === "" || label(e).toLowerCase().includes(q)),
  );
}
