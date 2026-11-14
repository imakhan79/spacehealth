export interface RelayConfig {
  databaseUrl: string;
  spacecraftId: string;
  /** Base URL of Mission Control, e.g. https://omni-mission-control.vercel.app */
  uplinkUrl: string;
  uplinkSecret: string;
  maxBatchEntries: number;
  /** Budget on uncompressed payload bytes per batch (gzip shrinks this a lot). */
  maxBatchBytes: number;
  requestTimeoutMs: number;
  probeTimeoutMs: number;
  idlePollMs: number;
  /** Link-level backoff while Earth is unreachable. */
  linkBackoffBaseMs: number;
  linkBackoffCapMs: number;
  /** Per-entry backoff after a failed send (applied in SQL). */
  entryBackoffBaseMs: number;
  entryBackoffCapMs: number;
  purgeIntervalMs: number;
  heartbeatPath: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
  const value = env[name];
  if (value === undefined || value.trim().length === 0) throw new Error(`missing required env ${name}`);
  return value.trim();
}

function int(env: Env, name: string, fallback: number, min: number): number {
  const raw = env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`env ${name} must be an integer >= ${min}`);
  return value;
}

export function loadConfig(env: Env): RelayConfig {
  const uplinkUrl = required(env, "OMNI_UPLINK_URL").replace(/\/+$/, "");
  if (!/^https?:\/\//.test(uplinkUrl)) throw new Error("OMNI_UPLINK_URL must be an http(s) URL");
  const uplinkSecret = required(env, "OMNI_UPLINK_SECRET");
  if (uplinkSecret.length < 32) throw new Error("OMNI_UPLINK_SECRET must be at least 32 characters");

  return {
    databaseUrl: required(env, "OMNI_RELAY_DATABASE_URL"),
    spacecraftId: required(env, "OMNI_SPACECRAFT_ID"),
    uplinkUrl,
    uplinkSecret,
    maxBatchEntries: int(env, "OMNI_UPLINK_MAX_BATCH_ENTRIES", 500, 1),
    maxBatchBytes: int(env, "OMNI_UPLINK_MAX_BATCH_BYTES", 1_000_000, 1024),
    requestTimeoutMs: int(env, "OMNI_UPLINK_REQUEST_TIMEOUT_MS", 30_000, 1000),
    probeTimeoutMs: int(env, "OMNI_UPLINK_PROBE_TIMEOUT_MS", 10_000, 500),
    idlePollMs: int(env, "OMNI_UPLINK_IDLE_POLL_MS", 10_000, 100),
    linkBackoffBaseMs: int(env, "OMNI_UPLINK_LINK_BACKOFF_BASE_MS", 5_000, 100),
    linkBackoffCapMs: int(env, "OMNI_UPLINK_LINK_BACKOFF_CAP_MS", 300_000, 1000),
    entryBackoffBaseMs: int(env, "OMNI_UPLINK_ENTRY_BACKOFF_BASE_MS", 5_000, 100),
    entryBackoffCapMs: int(env, "OMNI_UPLINK_ENTRY_BACKOFF_CAP_MS", 1_800_000, 1000),
    purgeIntervalMs: int(env, "OMNI_UPLINK_PURGE_INTERVAL_MS", 3_600_000, 1000),
    heartbeatPath: env.OMNI_RELAY_HEARTBEAT_PATH ?? "/tmp/omni-relay-heartbeat",
  };
}
