// Liveness only. Deliberately does NOT check the database: if Postgres is
// down, restarting the web tier would take the crew's UI away exactly when it
// needs to show a degraded state.
export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(
    { status: "ok", service: "omni-web", time: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
