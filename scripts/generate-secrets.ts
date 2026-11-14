// Generates every secret the stack needs, fully offline, into .env.
//   node scripts/generate-secrets.ts [--force]
// Refuses to overwrite an existing .env: rotating JWT_SECRET invalidates every
// crew session and API key, and POSTGRES_PASSWORD is baked into the database
// on first boot.
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const envPath = resolve(root, ".env");
const examplePath = resolve(root, ".env.example");
const force = process.argv.includes("--force");

const TEN_YEARS_S = 10 * 365 * 24 * 60 * 60;

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function signRoleKey(role: "anon" | "service_role", secret: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({ role, iss: "supabase", iat: now, exp: now + TEN_YEARS_S }));
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

// Alphanumeric only: these values end up inside connection URIs and nginx config.
function token(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function main(): void {
  if (existsSync(envPath) && !force) {
    console.error(`.env already exists at ${envPath}; refusing to overwrite (use --force to rotate ALL secrets).`);
    process.exit(1);
  }
  if (!existsSync(examplePath)) {
    console.error(`Missing ${examplePath}`);
    process.exit(1);
  }

  const jwtSecret = token(32);
  const generated: Record<string, string> = {
    POSTGRES_PASSWORD: token(24),
    JWT_SECRET: jwtSecret,
    ANON_KEY: signRoleKey("anon", jwtSecret),
    SERVICE_ROLE_KEY: signRoleKey("service_role", jwtSecret),
    SECRET_KEY_BASE: token(48),
    REALTIME_DB_ENC_KEY: token(8), // realtime requires exactly 16 characters
    OMNI_RELAY_PASSWORD: token(24),
  };

  const lines = readFileSync(examplePath, "utf8").split(/\r?\n/);
  const filled = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line);
    const key = match?.[1];
    if (key !== undefined && key in generated) return `${key}=${generated[key]}`;
    return line;
  });

  const missing = Object.keys(generated).filter((k) => !lines.some((l) => l.startsWith(`${k}=`)));
  if (missing.length > 0) {
    console.error(`.env.example lacks: ${missing.join(", ")}`);
    process.exit(1);
  }

  writeFileSync(envPath, filled.join("\n"), { mode: 0o600 });
  console.log(`Wrote ${envPath} (mode 600). Back it up to the mission's secure store before flight.`);
}

main();
