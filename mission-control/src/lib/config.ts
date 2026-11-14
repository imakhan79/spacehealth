import "server-only";
import { createPgStore } from "./pg-store.ts";
import { createEarthClient, createSupabaseStore } from "./supabase-store.ts";
import type { EarthStore, HandlerDeps } from "./handlers.ts";

// UPLINK_SECRETS = {"omni-1": "<hex secret shared with that spacecraft>", ...}
function loadUplinkSecrets(): Map<string, string> {
  const raw = process.env.UPLINK_SECRETS;
  if (raw === undefined || raw.length === 0) return new Map();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    const secrets = new Map<string, string>();
    for (const [id, secret] of Object.entries(parsed)) {
      if (typeof secret === "string" && secret.length >= 32) secrets.set(id, secret);
      else console.error(`UPLINK_SECRETS: ignoring ${id} (secret must be a string of >= 32 chars)`);
    }
    return secrets;
  } catch (error) {
    console.error(`UPLINK_SECRETS is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    return new Map();
  }
}

/** Preferred: direct Postgres as the least-privilege omni_ingest login. */
export function earthDatabaseUrl(): string | null {
  const url = process.env.DATABASE_URL;
  return url !== undefined && url.length > 0 ? url : null;
}

function earthSupabaseConfig(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  // Server-only key. The publishable/anon key cannot (and must not) ingest.
  const key = process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return { url, key };
}

function createStore(): EarthStore | null {
  const databaseUrl = earthDatabaseUrl();
  if (databaseUrl !== null) return createPgStore(databaseUrl);
  const supabase = earthSupabaseConfig();
  if (supabase !== null) return createSupabaseStore(createEarthClient(supabase.url, supabase.key));
  return null;
}

let cached: HandlerDeps | null = null;

export function handlerDeps(): HandlerDeps {
  if (cached !== null) return cached;
  const secrets = loadUplinkSecrets();
  cached = {
    store: createStore(),
    secretFor: (id) => secrets.get(id),
    nowMs: () => Date.now(),
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  };
  return cached;
}

export function configuredSpacecraft(): string[] {
  return [...loadUplinkSecrets().keys()];
}
