// Creates local crew identities: a GoTrue user + a crew_members row each.
// Runs on the spacecraft host against the loopback-only admin gateway port.
//
//   node scripts/provision-crew.ts crew.json
//
// Safe to re-run: existing users are reused, existing roster rows are left
// untouched. New passwords are written once to a mode-600 file for handover;
// they are never printed to the terminal.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Constants, type Enums, type TablesInsert } from "../src/types/database.types.ts";

type CrewRole = Enums<"crew_role">;

interface ManifestEntry {
  callsign: string;
  full_name: string;
  role: CrewRole;
  email: string;
}

interface AuthUser {
  id: string;
  email: string;
}

interface HttpResult {
  status: number;
  body: unknown;
}

const root = resolve(import.meta.dirname, "..");
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_GET_ATTEMPTS = 4;

function fail(message: string): never {
  console.error(`provision-crew: ${message}`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCrewRole(value: unknown): value is CrewRole {
  return typeof value === "string" && (Constants.public.Enums.crew_role as readonly string[]).includes(value);
}

function parseManifest(path: string): ManifestEntry[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail(`cannot read manifest ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) fail("manifest must be a non-empty JSON array");

  return raw.map((entry, i): ManifestEntry => {
    if (!isRecord(entry)) fail(`entry ${i} is not an object`);
    const { callsign, full_name, role, email } = entry;
    if (typeof callsign !== "string" || callsign.length === 0) fail(`entry ${i}: callsign required`);
    if (typeof full_name !== "string" || full_name.length === 0) fail(`entry ${i}: full_name required`);
    if (typeof email !== "string" || !email.includes("@")) fail(`entry ${i}: email required`);
    if (!isCrewRole(role)) fail(`entry ${i}: role must be one of ${Constants.public.Enums.crew_role.join(", ")}`);
    return { callsign, full_name, role, email: email.toLowerCase() };
  });
}

function makeClient(baseUrl: string, serviceKey: string) {
  const headers = {
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
    "Content-Type": "application/json",
  };

  async function once(method: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<HttpResult> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { ...headers, ...extra },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    return { status: res.status, body: parsed };
  }

  // Only GETs are retried automatically. A POST whose response was lost may
  // have succeeded; the script is idempotent, so the operator just re-runs it.
  async function get(path: string): Promise<HttpResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_GET_ATTEMPTS; attempt++) {
      try {
        const result = await once("GET", path);
        if (result.status < 500) return result;
        lastError = new Error(`HTTP ${result.status}`);
      } catch (error) {
        lastError = error;
      }
      await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return { get, send: once };
}

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (manifestPath === undefined) fail("usage: node scripts/provision-crew.ts <crew.json>");

  const envPath = resolve(root, ".env");
  if (!existsSync(envPath)) fail(".env not found; run scripts/generate-secrets.ts first");
  process.loadEnvFile(envPath);

  const serviceKey = process.env.SERVICE_ROLE_KEY;
  if (serviceKey === undefined || serviceKey.length === 0) fail("SERVICE_ROLE_KEY missing from .env");
  const baseUrl = `http://127.0.0.1:${process.env.OMNI_ADMIN_PORT ?? "8000"}`;

  const crew = parseManifest(resolve(manifestPath));
  const api = makeClient(baseUrl, serviceKey);

  let existing: Map<string, string>;
  try {
    const res = await api.get("/auth/v1/admin/users?page=1&per_page=1000");
    if (res.status !== 200 || !isRecord(res.body) || !Array.isArray(res.body.users)) {
      fail(`listing users failed (HTTP ${res.status})`);
    }
    existing = new Map(
      res.body.users
        .filter((u): u is AuthUser => isRecord(u) && typeof u.id === "string" && typeof u.email === "string")
        .map((u) => [u.email.toLowerCase(), u.id]),
    );
  } catch (error) {
    fail(`gateway unreachable at ${baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const issued: string[] = [];
  let failures = 0;

  for (const member of crew) {
    let userId = existing.get(member.email);
    let createdNow = false;

    try {
      if (userId === undefined) {
        const password = randomBytes(12).toString("base64url");
        const res = await api.send("POST", "/auth/v1/admin/users", {
          email: member.email,
          password,
          email_confirm: true,
          app_metadata: { callsign: member.callsign },
        });
        if (res.status !== 200 && res.status !== 201) {
          throw new Error(`create user HTTP ${res.status}: ${JSON.stringify(res.body)}`);
        }
        if (!isRecord(res.body) || typeof res.body.id !== "string") throw new Error("create user: no id in response");
        userId = res.body.id;
        createdNow = true;
        issued.push(`${member.callsign}\t${member.email}\t${password}`);
      }

      const row: TablesInsert<"crew_members"> = {
        auth_user_id: userId,
        callsign: member.callsign,
        full_name: member.full_name,
        role: member.role,
      };
      const res = await api.send("POST", "/rest/v1/crew_members?on_conflict=auth_user_id", row, {
        Prefer: "resolution=ignore-duplicates,return=minimal",
      });
      if (res.status !== 201 && res.status !== 200) {
        throw new Error(`roster insert HTTP ${res.status}: ${JSON.stringify(res.body)}`);
      }
      console.log(`ok   ${member.callsign} (${member.role})${createdNow ? " [new account]" : ""}`);
    } catch (error) {
      failures++;
      console.error(`FAIL ${member.callsign}: ${error instanceof Error ? error.message : String(error)}`);
      // Don't leave a login with no roster row: it could authenticate but see nothing.
      if (createdNow && userId !== undefined) {
        try {
          await api.send("DELETE", `/auth/v1/admin/users/${userId}`);
          issued.pop();
        } catch (cleanupError) {
          console.error(
            `     cleanup of auth user ${userId} also failed (${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}); re-run to repair`,
          );
        }
      }
    }
  }

  if (issued.length > 0) {
    const file = resolve(root, `crew-credentials-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`);
    writeFileSync(file, `callsign\temail\tinitial_password\n${issued.join("\n")}\n`, { mode: 0o600 });
    console.log(`\nInitial passwords for ${issued.length} new account(s): ${file}`);
    console.log("Hand them over, then destroy the file.");
  }

  if (failures > 0) process.exit(1);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
