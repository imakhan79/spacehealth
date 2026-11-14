// Boots real Postgres (PGlite, Postgres compiled to WASM) with the minimum of
// Supabase that our migrations rely on: the API roles and auth.users/auth.uid().
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Queryable } from "../../relay/src/store.ts";

const root = resolve(import.meta.dirname, "..", "..");

const SUPABASE_STUBS = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;
  -- Supabase's default privileges for objects created by postgres.
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

async function applyMigrations(db: PGlite, dir: string): Promise<void> {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files) await db.exec(readFileSync(resolve(dir, file), "utf8"));
}

export async function bootSpacecraftDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await applyMigrations(db, resolve(root, "supabase", "migrations"));
  await db.exec("grant usage on schema auth to omni_relay;");
  return db;
}

export async function bootEarthDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(SUPABASE_STUBS);
  await applyMigrations(db, resolve(root, "mission-control", "supabase", "migrations"));
  return db;
}

/** Runs one statement as `role`, optionally with an authenticated user id. */
export async function asRole(
  db: PGlite,
  role: string,
  sql: string,
  params: unknown[] = [],
  userId: string | null = null,
): Promise<Record<string, unknown>[]> {
  await db.exec(`begin; set local role ${role}; select set_config('request.jwt.claim.sub', '${userId ?? ""}', true);`);
  try {
    const result = await db.query<Record<string, unknown>>(sql, params);
    await db.exec("commit");
    return result.rows;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

export async function rows(db: PGlite, sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  return (await db.query<Record<string, unknown>>(sql, params)).rows;
}

/** A Queryable that executes as the omni_relay role, like the real worker. */
export function relayQueryable(db: PGlite): Queryable {
  return {
    async query(text, params) {
      const result = await asRole(db, "omni_relay", text, params ?? []);
      return { rows: result };
    },
  };
}

export const USERS = {
  gateway: "00000000-0000-0000-0000-00000000000a",
  alice: "00000000-0000-0000-0000-00000000000b",
  bob: "00000000-0000-0000-0000-00000000000c",
  surgeon: "00000000-0000-0000-0000-00000000000d",
} as const;

/** Seeds four crew identities (as postgres, the provisioning path). Returns crew_member ids. */
export async function seedCrew(db: PGlite): Promise<{ alice: string; bob: string }> {
  await db.exec(`
    insert into auth.users values ('${USERS.gateway}'), ('${USERS.alice}'), ('${USERS.bob}'), ('${USERS.surgeon}');
    insert into crew_members (auth_user_id, callsign, full_name, role) values
      ('${USERS.gateway}', 'GW', 'Sensor Gateway', 'sensor_gateway'),
      ('${USERS.alice}', 'ALPHA', 'Alice', 'crew'),
      ('${USERS.bob}', 'BRAVO', 'Bob', 'crew'),
      ('${USERS.surgeon}', 'DOC', 'Doc', 'flight_surgeon');
  `);
  const ids = await rows(db, "select callsign, id from crew_members");
  const byCallsign = new Map(ids.map((r) => [String(r.callsign), String(r.id)]));
  return { alice: byCallsign.get("ALPHA") ?? "", bob: byCallsign.get("BRAVO") ?? "" };
}

export async function insertTelemetry(db: PGlite, crewMemberId: string, count: number, startMinute = 0): Promise<void> {
  const values = Array.from({ length: count }, (_, i) => {
    const t = new Date(Date.UTC(2026, 10, 15, 0, startMinute + i)).toISOString();
    return `('${crewMemberId}', 'heart_rate', ${60 + (i % 40)}, 'bpm', '${t}', 'wrist-1')`;
  }).join(",");
  await asRole(
    db,
    "authenticated",
    `insert into crew_telemetry (crew_member_id, metric, value, unit, recorded_at, device_id) values ${values}`,
    [],
    USERS.gateway,
  );
}
