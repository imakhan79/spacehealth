import { configuredSpacecraft, earthDatabaseUrl } from "@/lib/config";
import { formatDuration, summarizeLink, type LinkBatch } from "@/lib/link-stats";
import { linkBatches, overview, type Overview } from "@/lib/pg-store";
import { LinkTimeline } from "./link-timeline";
import { Nav } from "./nav";

export const dynamic = "force-dynamic";

const muted = "#8b98a5";
const RANGES = [
  { key: "24h", label: "24 hours", ms: 24 * 3_600_000 },
  { key: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { key: "30d", label: "30 days", ms: 30 * 86_400_000 },
] as const;

const tile = { background: "#11171f", border: "1px solid #263241", borderRadius: 8, padding: "0.75rem 1rem", minWidth: 0 };

function Stat({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: string }) {
  return (
    <div style={tile}>
      <div style={{ color: muted, fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: tone ?? "#e6edf3", marginTop: 2 }}>{value}</div>
      {note && <div style={{ color: muted, fontSize: 12, marginTop: 2 }}>{note}</div>}
    </div>
  );
}

const cell = { padding: "0.4rem 0.7rem", borderBottom: "1px solid #1f2933", textAlign: "left" as const, verticalAlign: "top" as const };

export default async function MissionControlHome({ searchParams }: { searchParams: Promise<{ range?: string }> }) {
  const requested = (await searchParams).range;
  const range = RANGES.find((r) => r.key === requested) ?? RANGES[1];
  const databaseUrl = earthDatabaseUrl();
  const spacecraft = configuredSpacecraft();
  const now = Date.now();
  const from = now - range.ms;

  let data: Overview | null = null;
  let batches: LinkBatch[] = [];
  let dbError: string | null = null;
  if (databaseUrl !== null) {
    try {
      [data, batches] = await Promise.all([overview(databaseUrl), linkBatches(databaseUrl, from)]);
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error);
    }
  }
  const link = summarizeLink(batches, from, now);
  const pill = (active: boolean) => ({
    padding: "4px 12px",
    borderRadius: 6,
    fontSize: 14,
    textDecoration: "none",
    color: active ? "#e6edf3" : muted,
    background: active ? "#1b2430" : "transparent",
    fontWeight: active ? 600 : 400,
  });

  return (
    <main style={{ padding: "2rem 1rem", maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 0 }}>OMNI Mission Control</h1>
      <p style={{ color: muted, marginTop: "0.25rem" }}>Deep Space Network uplink receiver · Earth</p>
      <Nav active="status" />

      <ul style={{ lineHeight: 1.8, paddingLeft: "1.2rem" }}>
        <li>
          Earth database:{" "}
          {databaseUrl === null ? "not configured" : dbError === null ? "connected" : `error: ${dbError}`}
        </li>
        <li>Trusted spacecraft: {spacecraft.length === 0 ? "none (set UPLINK_SECRETS)" : spacecraft.join(", ")}</li>
        {data !== null && (
          <li>
            Records on Earth:{" "}
            {data.totals.length === 0 ? "none yet" : data.totals.map((t) => `${t.table} ${t.count}`).join(" · ")}
            {data.conflicts > 0 && <strong style={{ color: "#f0883e" }}> · {data.conflicts} conflict(s)</strong>}
          </li>
        )}
      </ul>

      <section aria-labelledby="link-heading">
        <h2 id="link-heading">Link health</h2>
        <nav aria-label="Time range" style={{ display: "inline-flex", gap: 4, border: "1px solid #263241", borderRadius: 8, padding: 2, marginBottom: 12 }}>
          {RANGES.map((r) => (
            <a key={r.key} href={`/?range=${r.key}`} aria-current={r.key === range.key ? "true" : undefined} style={pill(r.key === range.key)}>
              {r.label}
            </a>
          ))}
        </nav>
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))", marginBottom: 12 }}>
          <Stat
            label="Last contact"
            value={link.lastContactAt === null ? "never" : `${formatDuration(now - link.lastContactAt)} ago`}
            note={link.lastContactAt === null ? undefined : `${new Date(link.lastContactAt).toISOString().slice(0, 16).replace("T", " ")}Z`}
          />
          <Stat label={`Batches · ${range.label}`} value={link.batches.toLocaleString("en-US")} note={`${link.entries.toLocaleString("en-US")} entries · ${(link.bytes / 1024).toFixed(1)} KB`} />
          <Stat
            label="Transit delay"
            value={link.medianTransitMs === null ? "—" : formatDuration(link.medianTransitMs)}
            note={link.maxTransitMs === null ? "spacecraft clock → Earth" : `median · max ${formatDuration(link.maxTransitMs)}`}
          />
          <Stat
            label="Longest gap"
            value={link.longestGap === null ? "—" : formatDuration(link.longestGap.ms)}
            note={link.longestGap?.open ? "still open: no contact since" : "between contacts"}
          />
          <Stat
            label="Conflicts"
            value={link.conflicts.toLocaleString("en-US")}
            note={link.conflicts > 0 ? "warning: divergent versions" : "none in range"}
            tone={link.conflicts > 0 ? "#f0883e" : undefined}
          />
        </div>
        <div style={{ ...tile, padding: "0.75rem 1rem 0.5rem" }}>
          <LinkTimeline batches={batches} from={from} to={now} gap={link.longestGap} />
          <div style={{ display: "flex", gap: 16, fontSize: 12, color: muted, marginTop: 4 }} aria-label="Chart key">
            <span>
              <span aria-hidden style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#4493f0", marginRight: 4, verticalAlign: "middle" }} />
              Batch (height = entries)
            </span>
            <span>
              <span aria-hidden style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#f0883e", marginRight: 4, verticalAlign: "middle" }} />
              Batch with conflicts
            </span>
            <span>
              <span aria-hidden style={{ display: "inline-block", width: 10, height: 10, borderRadius: 2, background: "#8b98a533", marginRight: 4, verticalAlign: "middle" }} />
              Longest gap
            </span>
          </div>
        </div>
        <p style={{ color: muted, fontSize: 13 }}>Every batch is also listed under Recent batches below.</p>
      </section>

      <h2>Latest data received</h2>
      {data === null || data.records.length === 0 ? (
        <p style={{ color: muted }}>Nothing received yet. Data appears here after the spacecraft relay&apos;s next uplink window.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={cell}>Received (UTC)</th>
                <th style={cell}>Table</th>
                <th style={cell}>v</th>
                <th style={cell}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {data.records.map((r) => (
                <tr key={`${r.sourceTable}:${r.sourceId}`}>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>{r.receivedAt.slice(0, 19).replace("T", " ")}</td>
                  <td style={cell}>{r.sourceTable}</td>
                  <td style={cell}>{r.rowVersion}</td>
                  <td style={cell}>{r.detail}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2>Recent batches</h2>
      {data === null || data.batches.length === 0 ? (
        <p style={{ color: muted }}>No batches received yet.</p>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
            <thead>
              <tr>
                <th style={cell}>Received (UTC)</th>
                <th style={cell}>Spacecraft</th>
                <th style={cell}>Entries</th>
                <th style={cell}>Bytes (gzip)</th>
                <th style={cell}>Batch</th>
              </tr>
            </thead>
            <tbody>
              {data.batches.map((b) => (
                <tr key={b.batchId}>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>{b.receivedAt.slice(0, 19).replace("T", " ")}</td>
                  <td style={cell}>{b.spacecraftId}</td>
                  <td style={cell}>{b.entryCount}</td>
                  <td style={cell}>{b.compressedBytes}</td>
                  <td style={{ ...cell, fontFamily: "monospace" }}>{b.batchId.slice(0, 8)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
