# OMNI — spacecraft edge stack

Ambient crew health monitoring that runs entirely on the spacecraft's own
servers and syncs with Mission Control only when a DSN uplink is available.

## Layout

| Path | What |
|---|---|
| `supabase/migrations/` | Postgres schema, sync triggers, RLS (Phase 1) |
| `src/types/database.types.ts` | Supabase types for the schema |
| `docker-compose.yml` | Trimmed self-hosted Supabase + Next.js + nginx gateway |
| `docker-compose.flight.yml` | Overlay that forbids registry pulls |
| `docker/gateway/` | nginx: TLS, API-key gate, same-origin routing |
| `docker/migrate/` | Checksummed one-shot migration runner |
| `scripts/` | Secrets, TLS, crew provisioning, flight bundle |

## Topology

```
crew tablets ──HTTPS:8443──► gateway (nginx) ──┬─ /            → web (Next.js standalone)
                                               ├─ /auth/v1/    → auth (GoTrue)
host loopback ──HTTP:8000──►  (admin keys)     ├─ /rest/v1/    → rest (PostgREST)
                                               └─ /realtime/v1/→ realtime
                                                        all ──► db (Postgres 17)
```

Only `gateway` is attached to a routable network. Everything else is on the
`backend` network, declared `internal: true`, so Docker gives those containers
no route off the host at all. Phase 3's relay will be the single service
allowed onto the DSN-facing link.

## First boot

```sh
npm ci                                   # Earth only: needs the npm registry
node scripts/generate-secrets.ts         # writes .env (mode 600), offline
sh scripts/generate-certs.sh             # mission-local CA + gateway cert
docker compose up -d                     # db → auth → migrate → web, rest, realtime, gateway
node scripts/provision-crew.ts scripts/crew.example.json
```

Install `data/tls/ca.crt` as a trusted root on every crew device.

## Shipping to the spacecraft

```sh
# Earth
sh scripts/flight-bundle.sh save          # every image → omni-flight-bundle.tar + .sha256
# Spacecraft
sh scripts/flight-bundle.sh load
docker compose -f docker-compose.yml -f docker-compose.flight.yml up -d
```

With the flight overlay, a missing image fails at `up` instead of reaching for Docker Hub.

## Authentication without Earth

Identity is fully local; there is no OAuth provider, email, SMS or any
third-party check to wait on during a blackout.

- **Who can log in.** GoTrue runs on the spacecraft with `DISABLE_SIGNUP=true`.
  Accounts exist only if `scripts/provision-crew.ts` created them (before
  launch, or onboard by the commander on the host). Each account is bound to a
  `crew_members` row whose `role` drives every RLS decision.
- **How.** Email + password against the local GoTrue (`/auth/v1/token`). Emails
  are just unique identifiers (`cmo@crew.omni.local`); `MAILER_AUTOCONFIRM` is
  on because no mail can ever be delivered.
- **Tokens.** JWTs are signed with `JWT_SECRET`, generated offline and stored
  only in the spacecraft's `.env`. PostgREST and Realtime verify them with the
  same local secret: no JWKS fetch, no issuer discovery. Access tokens last
  `JWT_EXPIRY` (1 h); refresh tokens rotate locally, so sessions survive any
  length of blackout.
- **No internet lookups.** The two GoTrue features that would reach out
  (extended email MX validation, HaveIBeenPwned) are pinned off, and the
  internal network would block them regardless.
- **Keys.** The anon key is accepted on the crew LAN. The service_role key is
  only honoured on the gateway's `127.0.0.1:8000` listener, so a leaked key is
  useless from a tablet.
- **Machines.** The biomedical sensor bus logs in as a `sensor_gateway` crew
  identity; RLS lets it insert telemetry/alerts and nothing else.
- **Lost password.** No recovery email exists. The commander (or flight
  surgeon) resets it on the host via the GoTrue admin API with the service key.
- **Optional.** GoTrue's TOTP MFA works offline (time-based) if the mission wants it.

## Resource budget (defaults)

| Service | Memory | Notes |
|---|---|---|
| db | 768 MB | durability settings pinned on; 60 s clean-shutdown grace |
| realtime | 384 MB | |
| web | 384 MB | Node heap capped at 256 MB, read-only root FS |
| auth / rest | 128 MB each | |
| gateway | 64 MB | |

All tunable in `.env`. Logs are capped (3 × 10 MB per service) to protect disk.
