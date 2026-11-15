// Simulated spacecraft for ground testing: boots the real spacecraft schema in
// PGlite, generates a crew shift of vitals, alerts and cabin acoustics through
// the normal (RLS + trigger) write paths, then drains the uplink queue to
// Mission Control with the real relay code.
//
//   node scripts/simulate-spacecraft.ts [minutes-of-data]
// Uses OMNI_UPLINK_URL, OMNI_UPLINK_SECRET, OMNI_SPACECRAFT_ID from .env.
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { loadConfig } from "../relay/src/config.ts";
import { createEarthClient } from "../relay/src/earth-client.ts";
import { initialState, runCycle, type RelayDeps } from "../relay/src/relay.ts";
import { createRelayStore } from "../relay/src/store.ts";
import { USERS, asRole, bootSpacecraftDb, relayQueryable, rows, seedCrew } from "../tests/helpers/db.ts";

const minutes = Number(process.argv[2] ?? "30");
process.loadEnvFile(resolve(import.meta.dirname, "..", ".env"));

const config = loadConfig({ ...process.env, OMNI_RELAY_DATABASE_URL: "pglite://simulated" });
console.log(`Simulating ${config.spacecraftId}: ${minutes} min of crew data -> ${config.uplinkUrl}`);

const db = await bootSpacecraftDb();
const crew = await seedCrew(db);
const start = Date.now() - minutes * 60_000;

// Vitals: one sample per minute per metric for two crew members.
const metrics: [string, string, (i: number) => number][] = [
  ["heart_rate", "bpm", (i) => 62 + Math.round(8 * Math.sin(i / 6)) + (i > minutes - 6 ? 38 : 0)],
  ["spo2", "%", (i) => (i > minutes - 4 ? 89 : 97 + (i % 2))],
  ["respiratory_rate", "br/min", (i) => 14 + (i % 3)],
  ["core_body_temp", "°C", (i) => 36.8 + (i % 5) / 10],
];
for (const [member, device] of [[crew.alice, "wrist-alpha"], [crew.bob, "wrist-bravo"]] as const) {
  const values: string[] = [];
  for (let i = 0; i < minutes; i++) {
    const at = new Date(start + i * 60_000).toISOString();
    for (const [metric, unit, f] of metrics) values.push(`('${member}', '${metric}', ${f(i)}, '${unit}', '${at}', '${device}', 98)`);
  }
  await asRole(db, "authenticated",
    `insert into crew_telemetry (crew_member_id, metric, value, unit, recorded_at, device_id, signal_quality) values ${values.join(",")}`,
    [], USERS.gateway);
}

// Dosimetry every 5 minutes: dose rate near deep-space background and a
// running career total.
for (const [member, device, startMsv] of [[crew.alice, "dosi-alpha", 182], [crew.bob, "dosi-bravo", 96]] as const) {
  const values: string[] = [];
  let total = startMsv;
  for (let i = 0; i < minutes; i += 5) {
    const at = new Date(start + i * 60_000).toISOString();
    const rate = 72 + (i % 7);
    total += (rate * 5) / 60 / 1000;
    values.push(`('${member}', 'radiation_dose_rate', ${rate}, 'µSv/h', '${at}', '${device}', 99)`);
    values.push(`('${member}', 'cumulative_radiation_dose', ${total.toFixed(4)}, 'mSv', '${at}', '${device}', 99)`);
  }
  await asRole(db, "authenticated",
    `insert into crew_telemetry (crew_member_id, metric, value, unit, recorded_at, device_id, signal_quality) values ${values.join(",")}`,
    [], USERS.gateway);
}

// Alerts raised by the sensor gateway; Alice overrides the CAUTION.
await asRole(db, "authenticated",
  `insert into health_alerts (crew_member_id, metric, severity, message) values
     ($1, 'heart_rate', 'caution', 'Heart rate 100+ bpm sustained 5 min'),
     ($1, 'spo2', 'emergency', 'SpO2 below 90% — check suit O2 supply')`,
  [crew.alice], USERS.gateway);
await asRole(db, "authenticated",
  "update health_alerts set status = 'overridden', override_reason = 'Scheduled ARED exercise session' where severity = 'caution'",
  [], USERS.alice);

// Cabin acoustics, 5-minute windows in two modules.
for (const moduleId of ["HAB-A", "NODE-2"]) {
  const windows: string[] = [];
  for (let i = 0; i < minutes; i += 5) {
    const leq = moduleId === "NODE-2" && i > minutes - 10 ? 68.5 : 55 + (i % 4);
    windows.push(`('${moduleId}', '${moduleId}-mic1', '${new Date(start + i * 60_000).toISOString()}', 300, ${leq}, ${leq + 6}, ${leq > 65})`);
  }
  await asRole(db, "authenticated",
    `insert into ambient_acoustics (module_id, sensor_id, window_start, window_seconds, laeq_dba, lmax_dba, limit_exceeded) values ${windows.join(",")}`,
    [], USERS.gateway);
}

const [queued] = await rows(db, "select count(*)::int n from uplink_queue where sync_status = 'queued_for_earth'");
console.log(`Queued for Earth: ${String(queued?.n)} entries`);

const deps: RelayDeps = {
  config,
  store: createRelayStore(relayQueryable(db), config),
  earth: createEarthClient({
    baseUrl: config.uplinkUrl,
    spacecraftId: config.spacecraftId,
    secret: config.uplinkSecret,
    requestTimeoutMs: config.requestTimeoutMs,
    probeTimeoutMs: config.probeTimeoutMs,
  }),
  log: (level, event, fields = {}) => {
    if (event !== "link_state_write_failed") console.log(`[${level}] ${event} ${JSON.stringify(fields)}`);
  },
  newBatchId: randomUUID,
  now: () => new Date(),
};

const state = initialState(config);
for (let cycle = 0; cycle < 100; cycle++) {
  const wait = await runCycle(state, deps);
  if (wait === config.idlePollMs) break;
  if (wait > 0) {
    console.log(`Relay backing off ${wait} ms`);
    if (state.linkFailures >= 3) break;
    await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
  }
}

const summary = await rows(db, "select sync_status, count(*)::int n from uplink_queue group by 1 order by 1");
console.log("Spacecraft queue:", summary.map((r) => `${String(r.sync_status)}=${String(r.n)}`).join(" "));
await db.close();
