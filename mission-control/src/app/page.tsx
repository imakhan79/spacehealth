import { configuredSpacecraft, earthDatabaseConfig } from "@/lib/config";
import { createEarthClient, recentBatches, type RecentBatch } from "@/lib/supabase-store";

export const dynamic = "force-dynamic";

// Operational status only: shows whether uplink is configured and what has
// arrived. No crew health data is rendered here until ground auth exists.
export default async function MissionControlHome() {
  const db = earthDatabaseConfig();
  const spacecraft = configuredSpacecraft();

  let batches: RecentBatch[] = [];
  let dbError: string | null = null;
  if (db !== null) {
    try {
      batches = await recentBatches(createEarthClient(db.url, db.key), 20);
    } catch (error) {
      dbError = error instanceof Error ? error.message : String(error);
    }
  }

  const cell = { padding: "0.4rem 0.8rem", borderBottom: "1px solid #1f2933", textAlign: "left" as const };

  return (
    <main style={{ padding: "2rem", maxWidth: 960, margin: "0 auto" }}>
      <h1 style={{ marginBottom: 0 }}>OMNI Mission Control</h1>
      <p style={{ color: "#8b98a5", marginTop: "0.25rem" }}>Deep Space Network uplink receiver</p>

      <ul style={{ lineHeight: 1.8 }}>
        <li>Earth database: {db === null ? "not configured" : dbError === null ? "connected" : `error: ${dbError}`}</li>
        <li>Trusted spacecraft: {spacecraft.length === 0 ? "none (set UPLINK_SECRETS)" : spacecraft.join(", ")}</li>
      </ul>

      <h2>Recent batches</h2>
      {batches.length === 0 ? (
        <p style={{ color: "#8b98a5" }}>No batches received yet.</p>
      ) : (
        <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
          <thead>
            <tr>
              <th style={cell}>Received</th>
              <th style={cell}>Spacecraft</th>
              <th style={cell}>Entries</th>
              <th style={cell}>Bytes (gzip)</th>
              <th style={cell}>Batch</th>
            </tr>
          </thead>
          <tbody>
            {batches.map((b) => (
              <tr key={b.batch_id}>
                <td style={cell}>{new Date(b.received_at).toISOString()}</td>
                <td style={cell}>{b.spacecraft_id}</td>
                <td style={cell}>{b.entry_count}</td>
                <td style={cell}>{b.compressed_bytes}</td>
                <td style={{ ...cell, fontFamily: "monospace" }}>{b.batch_id.slice(0, 8)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
