import { PROTOCOL_VERSION } from "../../../../../../packages/uplink-protocol/index.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Link probe target for the relay. Unauthenticated and deliberately bland.
export function GET(): Response {
  return Response.json(
    { ok: true, protocol: PROTOCOL_VERSION, time: new Date().toISOString() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
