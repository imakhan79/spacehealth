import { earthDatabaseUrl } from "@/lib/config";
import { crewHealth, crewTrends, type CrewHealth, type CrewTrends, type GroundAlert, type GroundVital } from "@/lib/pg-store";
import {
  METRICS,
  RADIATION,
  careerDoseTone,
  doseRateTone,
  latestRadiation,
  toneOf,
} from "../../../../packages/vital-thresholds/index.ts";
import { AutoRefresh } from "../auto-refresh";
import { Nav } from "../nav";
import { TrendChart } from "./trend-chart";

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
  series: "#4493f0",
};

const SEVERITY_COLOR: Record<string, string> = {
  emergency: C.emergency,
  warning: C.warning,
  caution: C.caution,
  advisory: C.info,
};

const TONE_COLOR = { normal: null, caution: C.caution, emergency: C.emergency } as const;

const RANGES = [
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "6h", label: "6 hours", ms: 6 * 3_600_000 },
] as const;

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
              <div style={{ fontSize: 22, fontWeight: 600, color: s ? TONE_COLOR[toneOf(m, s.value)] ?? "inherit" : C.muted, fontVariantNumeric: "tabular-nums" }}>
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

function trendTable(trends: CrewTrends | null): [number, Partial<Record<string, number>>][] {
  if (!trends) return [];
  const byTime = new Map<number, Partial<Record<string, number>>>();
  for (const m of METRICS) for (const p of trends.series[m.key]) byTime.set(p.t, { ...byTime.get(p.t), [m.key]: p.v });
  return [...byTime.entries()].sort((a, b) => b[0] - a[0]);
}

export default async function CrewHealthPage({ searchParams }: { searchParams: Promise<{ crew?: string; range?: string }> }) {
  const params = await searchParams;
  const range = RANGES.find((r) => r.key === params.range) ?? RANGES[0];
  const databaseUrl = earthDatabaseUrl();
  let data: CrewHealth | null = null;
  let trends: CrewTrends | null = null;
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
  // Callsigns are unique aboard, so two records sharing one mean the spacecraft
  // database was rebuilt (or a simulator re-run). Show one card per callsign,
  // from the record with the newest vitals; alerts still resolve every record.
  const newest = (id: string) => vitalsByCrew.get(id)?.[0]?.recordedAt ?? "";
  const crewShown = [
    ...(data?.crew ?? [])
      .reduce((byCallsign, c) => {
        const cur = byCallsign.get(c.callsign);
        if (!cur || newest(c.id) > newest(cur.id)) byCallsign.set(c.callsign, c);
        return byCallsign;
      }, new Map<string, NonNullable<CrewHealth["crew"][number]>>())
      .values(),
  ];
  const crewWithVitals = crewShown.filter((c) => vitalsByCrew.has(c.id));
  const radiation = latestRadiation(
    (data?.vitals ?? []).map((v) => ({ crew_member_id: v.crewId, metric: v.metric, value: v.value, recorded_at: v.recordedAt })),
  );
  const crewWithDose = crewShown.filter((c) => radiation.has(c.id));
  const trendCrew = crewWithVitals.find((c) => c.id === params.crew) ?? crewWithVitals[0] ?? null;
  if (databaseUrl !== null && trendCrew !== null && error === null) {
    try {
      trends = await crewTrends(databaseUrl, trendCrew.id, range.ms);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const trendEnd = trends?.endsAt ? Date.parse(trends.endsAt) : now;
  const href = (crew: string, r: string) => `/dashboard?crew=${encodeURIComponent(crew)}&range=${r}`;
  const pill = (active: boolean) => ({
    padding: "4px 12px",
    borderRadius: 6,
    fontSize: 14,
    textDecoration: "none",
    color: active ? "#e6edf3" : C.muted,
    background: active ? "#1b2430" : "transparent",
    fontWeight: active ? 600 : 400,
  });
  const swatch = (color: string) => ({
    display: "inline-block",
    width: 12,
    height: 12,
    borderRadius: 3,
    background: `${color}40`,
    verticalAlign: "middle",
    marginRight: 4,
  });
  const segmented = { display: "flex", gap: 4, border: `1px solid ${C.border}`, borderRadius: 8, padding: 2 };

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
        <section>
          <h2>Radiation dose</h2>
          <div style={card}>
            <div style={{ color: C.muted, fontSize: 12, marginBottom: 8 }}>
              Career limit {RADIATION.careerLimitMsv} {RADIATION.cumulativeUnit} (NASA-STD-3001)
            </div>
            {crewWithDose.length === 0 ? (
              <span style={{ color: C.muted }}>No dosimeter readings received.</span>
            ) : (
              crewWithDose.map((c) => {
                const r = radiation.get(c.id)!;
                const tone = r.cumulativeMsv === null ? "normal" : careerDoseTone(r.cumulativeMsv);
                const rateTone = r.doseRate === null ? "normal" : doseRateTone(r.doseRate);
                const color = TONE_COLOR[tone] ?? C.series;
                const share = r.cumulativeMsv === null ? 0 : r.cumulativeMsv / RADIATION.careerLimitMsv;
                const pct = Math.round(share * 100);
                const word = { normal: "", caution: " · caution", emergency: " · emergency" } as const;
                return (
                  <div key={c.id} style={{ padding: "8px 0", borderBottom: `1px solid ${C.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                      <strong>{c.callsign}</strong>
                      <span style={{ color: C.muted, fontSize: 12 }}>{ago(r.at, now)}</span>
                    </div>
                    {r.cumulativeMsv !== null && (
                      <>
                        <div
                          role="meter"
                          aria-label={`${c.callsign} career radiation dose`}
                          aria-valuemin={0}
                          aria-valuemax={RADIATION.careerLimitMsv}
                          aria-valuenow={Number(r.cumulativeMsv.toFixed(1))}
                          aria-valuetext={`${r.cumulativeMsv.toFixed(1)} mSv, ${pct}% of the career limit`}
                          style={{ height: 8, borderRadius: 999, background: `${color}33`, overflow: "hidden", margin: "6px 0 4px" }}
                        >
                          <div style={{ height: "100%", width: `${Math.min(100, share * 100)}%`, borderRadius: 999, background: color }} />
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                          <span style={{ fontWeight: 600, color: TONE_COLOR[tone] ?? "inherit" }}>
                            {r.cumulativeMsv.toFixed(1)} <span style={{ color: C.muted, fontWeight: 400, fontSize: 12 }}>mSv</span>
                          </span>
                          <span style={{ color: C.muted, fontSize: 12 }}>
                            {pct}% of career limit{word[tone]}
                          </span>
                        </div>
                      </>
                    )}
                    {r.doseRate !== null && (
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted, marginTop: 2 }}>
                        <span>
                          Dose rate{" "}
                          <span style={{ fontWeight: 600, fontSize: 13, color: TONE_COLOR[rateTone] ?? "#e6edf3" }}>{Math.round(r.doseRate)}</span>{" "}
                          {RADIATION.doseRateUnit}
                          {word[rateTone]}
                        </span>
                        <span>≈ {((r.doseRate * 24) / 1000).toFixed(2)} mSv/day</span>
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      {trendCrew && (
        <section style={{ marginTop: "1.75rem" }} aria-labelledby="trends-heading">
          <h2 id="trends-heading">Vital trends</h2>
          {/* One row of controls above the charts; they scope every chart below. */}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", marginBottom: 12 }}>
            <nav aria-label="Crew member" style={segmented}>
              {crewWithVitals.map((c) => (
                <a key={c.id} href={href(c.id, range.key)} aria-current={c.id === trendCrew.id ? "true" : undefined} style={pill(c.id === trendCrew.id)}>
                  {c.callsign}
                </a>
              ))}
            </nav>
            <nav aria-label="Time range" style={segmented}>
              {RANGES.map((r) => (
                <a key={r.key} href={href(trendCrew.id, r.key)} aria-current={r.key === range.key ? "true" : undefined} style={pill(r.key === range.key)}>
                  {r.label}
                </a>
              ))}
            </nav>
            <span style={{ display: "flex", gap: 12, fontSize: 12, color: C.muted }}>
              <span>
                <span aria-hidden style={swatch(C.caution)} />
                Caution range
              </span>
              <span>
                <span aria-hidden style={swatch(C.emergency)} />
                Emergency range
              </span>
            </span>
          </div>
          <p style={{ color: C.muted, fontSize: 13, marginTop: 0 }}>
            {trends?.endsAt
              ? `Window ends at the newest sample received for ${trendCrew.callsign}, ${ago(trends.endsAt, now)}.`
              : `No samples received for ${trendCrew.callsign}.`}
          </p>
          <div style={{ ...card, display: "grid", gap: 16, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))" }}>
            {METRICS.map((spec) => (
              <TrendChart key={spec.key} spec={spec} points={trends?.series[spec.key] ?? []} from={trendEnd - range.ms} to={trendEnd} />
            ))}
          </div>
          <details style={{ marginTop: 8, fontSize: 14 }}>
            <summary style={{ cursor: "pointer", color: C.muted }}>Show samples as a table</summary>
            <div style={{ maxHeight: 288, overflow: "auto", border: `1px solid ${C.border}`, borderRadius: 6, marginTop: 8 }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontVariantNumeric: "tabular-nums", textAlign: "left" }}>
                <thead style={{ position: "sticky", top: 0, background: C.card, color: C.muted, fontSize: 12 }}>
                  <tr>
                    <th style={{ padding: "6px 12px", fontWeight: 500 }}>Time</th>
                    {METRICS.map((m) => (
                      <th key={m.key} style={{ padding: "6px 12px", fontWeight: 500 }}>
                        {m.label} ({m.unit})
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {trendTable(trends).map(([t, row]) => (
                    <tr key={t} style={{ borderTop: `1px solid ${C.border}` }}>
                      <td style={{ padding: "4px 12px", color: C.muted }}>{new Date(t).toISOString().slice(11, 19)}Z</td>
                      {METRICS.map((m) => (
                        <td key={m.key} style={{ padding: "4px 12px" }}>
                          {row[m.key] === undefined ? "—" : row[m.key]!.toFixed(m.digits)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </section>
      )}
    </main>
  );
}
