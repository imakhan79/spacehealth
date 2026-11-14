import { configuredSpacecraft, earthDatabaseUrl } from "@/lib/config";
import { overview, type Overview } from "@/lib/pg-store";

export const dynamic = "force-dynamic";

const muted = "#8b98a5";
const cell = { padding: "0.4rem 0.7rem", borderBottom: "1px solid #1f2933", textAlign: "left" as const, verticalAlign: "top" as const };

export default async function MissionControlHome() {
  const databaseUrl = earthDatabaseUrl();
  const spacecraft = configuredSpacecraft();

  let data: Overview | null = null;
  let dbError: string | null = null;
  if (databaseUrl !== null) {
    try {
      data = await overview(databaseUrl);
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error);
    }
  }

  return (
    <main style={{ padding: "2rem 1rem", maxWidth: 1100, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 0 }}>OMNI Mission Control</h1>
      <p style={{ color: muted, marginTop: "0.25rem" }}>Deep Space Network uplink receiver · Earth</p>

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
