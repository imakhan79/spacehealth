import { earthDatabaseUrl } from "@/lib/config";
import { crewHealth, type CrewHealth, type GroundAlert, type GroundVital } from "@/lib/pg-store";
import { AutoRefresh } from "../auto-refresh";
import { Nav } from "../nav";

export const dynamic = "force-dynamic";

// Earth-side view of crew health, rebuilt from what the DSN uplink delivered.
// It is only as fresh as the last uplink window; the crew's own dashboard
// aboard is always live.

const C = {
  muted: "#8b98a5",
  border: "#263241",
  card: "#11171f",
  ok: "#3fb950",
  info: "#58a6ff",
  caution: "#d29922",
  warning: "#f0883e",
  emergency: "#ff5c57",
};

const SEVERITY_COLOR: Record<string, string> = {
  emergency: C.emergency,
  warning: C.warning,
  caution: C.caution,
  advisory: C.info,
};

const METRICS: { key: string; label: string; digits: number; tone: (v: number) => string | null }[] = [
  { key: "heart_rate", label: "Heart rate", digits: 0, tone: (v) => (v > 140 || v < 40 ? C.emergency : v > 110 ? C.caution : null) },
  { key: "spo2", label: "SpO₂", digits: 0, tone: (v) => (v < 90 ? C.emergency : v < 94 ? C.caution : null) },
  { key: "respiratory_rate", label: "Resp. rate", digits: 0, tone: (v) => (v > 30 || v < 8 ? C.emergency : v > 22 ? C.caution : null) },
  { key: "core_body_temp", label: "Core temp", digits: 1, tone: (v) => (v > 39 || v < 35 ? C.emergency : v > 38 ? C.caution : null) },
];

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

const card = { background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, padding: "0.9rem 1rem" };

function AlertCard({ alert, callsign, now }: { alert: GroundAlert; callsign: (id: string | null) => string; now: number }) {
  const color = SEVERITY_COLOR[alert.severity] ?? C.muted;
  const open = alert.status === "active";
  return (
    <div style={{ ...card, borderColor: open ? color : C.border, opacity: open ? 1 : 0.85 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <span style={{ color, border: `1px solid ${color}`, borderRadius: 999, padding: "1px 8px", fontSize: 12, fontWeight: 700 }}>
          {alert.severity.toUpperCase()}
        </span>
        <strong>{callsign(alert.crewId)}</strong>
        <span style={{ color: C.muted, fontSize: 13 }}>{ago(alert.triggeredAt, now)}</span>
        <span style={{ marginLeft: "auto", color: C.muted, fontSize: 12 }}>
          {alert.status}
          {alert.rowVersion > 1 ? ` · v${alert.rowVersion}` : ""}
        </span>
      </div>
      <div style={{ marginTop: 6 }}>{alert.message}</div>
      {alert.status === "overridden" && (
        <div style={{ marginTop: 6, color: C.muted, fontSize: 13 }}>
          Overridden by {callsign(alert.overriddenBy)}: “{alert.overrideReason}”
        </div>
      )}
      {alert.status === "acknowledged" && (
        <div style={{ marginTop: 6, color: C.muted, fontSize: 13 }}>Acknowledged by {callsign(alert.acknowledgedBy)}</div>
      )}
    </div>
  );
}

function Vitals({ samples, now }: { samples: GroundVital[]; now: number }) {
  const latest = samples[0];
  const hr = samples.filter((s) => s.metric === "heart_rate").slice(0, 30).reverse().map((s) => s.value);
  const min = Math.min(...hr);
  const span = Math.max(...hr) - min || 1;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.6rem 1rem", marginTop: 8 }}>
        {METRICS.map((m) => {
          const s = samples.find((x) => x.metric === m.key);
          return (
            <div key={m.key}>
              <div style={{ color: C.muted, fontSize: 12 }}>{m.label}</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: s ? m.tone(s.value) ?? "inherit" : C.muted, fontVariantNumeric: "tabular-nums" }}>
                {s ? s.value.toFixed(m.digits) : "—"}
                {s && <span style={{ fontSize: 12, fontWeight: 400, color: C.muted, marginLeft: 4 }}>{s.unit}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {hr.length > 1 && (
        <svg viewBox="0 0 100 30" preserveAspectRatio="none" style={{ width: "100%", height: 32, marginTop: 8, color: C.info }} aria-hidden>
          <polyline
            points={hr.map((v, i) => `${((i / (hr.length - 1)) * 100).toFixed(1)},${(28 - ((v - min) / span) * 24).toFixed(1)}`).join(" ")}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      )}
      <div style={{ color: C.muted, fontSize: 12, marginTop: 4 }}>Latest sample {latest ? ago(latest.recordedAt, now) : "—"}</div>
    </>
  );
}

export default async function CrewHealthPage() {
  const databaseUrl = earthDatabaseUrl();
  let data: CrewHealth | null = null;
  let error: string | null = null;
  if (databaseUrl === null) error = "Earth database not configured";
  else {
    try {
      data = await crewHealth(databaseUrl);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }

  const now = Date.now();
  const crewById = new Map((data?.crew ?? []).map((c) => [c.id, c]));
  const callsign = (id: string | null): string => (id ? crewById.get(id)?.callsign ?? "crew" : "crew");
  const vitalsByCrew = new Map<string, GroundVital[]>();
  for (const v of data?.vitals ?? []) vitalsByCrew.set(v.crewId, [...(vitalsByCrew.get(v.crewId) ?? []), v]);
  const rank: Record<string, number> = { active: 0, acknowledged: 1, overridden: 2, resolved: 3 };
  const alerts = [...(data?.alerts ?? [])].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
  const crewWithVitals = (data?.crew ?? []).filter((c) => vitalsByCrew.has(c.id));

  return (
    <main style={{ padding: "2rem 1rem", maxWidth: 1100, margin: "0 auto" }}>
      <AutoRefresh seconds={15} />
      <h1 style={{ margin: 0 }}>OMNI Mission Control</h1>
      <Nav active="dashboard" />

      <div style={{ ...card, marginTop: "1.25rem", borderColor: C.info, color: C.info, fontSize: 14 }}>
        Ground view, rebuilt from DSN uplinks. Last uplink received <strong>{ago(data?.lastBatchAt ?? null, now)}</strong>. The crew&apos;s
        dashboard aboard is always live; this view updates only when the spacecraft has an Earth link.
      </div>

      {error && <p style={{ color: C.emergency }}>Earth database error: {error}</p>}

      <h2 style={{ marginTop: "1.75rem" }}>Health alerts</h2>
      {alerts.length === 0 ? (
        <p style={{ color: C.muted }}>No alerts received.</p>
      ) : (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 420px), 1fr))" }}>
          {alerts.map((a) => (
            <AlertCard key={a.id} alert={a} callsign={callsign} now={now} />
          ))}
        </div>
      )}

      <div style={{ display: "grid", gap: 24, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 320px), 1fr))", marginTop: "1.75rem" }}>
        <section>
          <h2>Crew vitals</h2>
          {crewWithVitals.length === 0 ? (
            <p style={{ color: C.muted }}>No vitals received.</p>
          ) : (
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 280px), 1fr))" }}>
              {crewWithVitals.map((c) => (
                <div key={c.id} style={card}>
                  <strong>{c.callsign}</strong> <span style={{ color: C.muted, fontSize: 13 }}>{c.fullName}</span>
                  <Vitals samples={vitalsByCrew.get(c.id) ?? []} now={now} />
                </div>
              ))}
            </div>
          )}
        </section>
        <section>
          <h2>Cabin acoustics</h2>
          <div style={card}>
            {(data?.acoustics ?? []).length === 0 ? (
              <span style={{ color: C.muted }}>No readings received.</span>
            ) : (
              (data?.acoustics ?? []).map((a) => (
                <div key={a.moduleId} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: `1px solid ${C.border}` }}>
                  <span>
                    {a.moduleId} <span style={{ color: C.muted, fontSize: 12 }}>{ago(a.windowStart, now)}</span>
                  </span>
                  <span style={{ fontVariantNumeric: "tabular-nums" }}>
                    {a.laeq.toFixed(1)} dBA{" "}
                    {a.limitExceeded && <strong style={{ color: C.warning, fontSize: 12 }}>LIMIT</strong>}
                  </span>
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
