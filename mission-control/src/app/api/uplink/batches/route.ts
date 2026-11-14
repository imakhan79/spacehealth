import { MAX_COMPRESSED_BYTES } from "../../../../../../packages/uplink-protocol/index.ts";
import { handlerDeps } from "@/lib/config";
import { handleBatch, signedHeadersFrom } from "@/lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_COMPRESSED_BYTES) {
    return Response.json({ error: "batch too large" }, { status: 413 });
  }

  let body: Uint8Array;
  try {
    body = new Uint8Array(await request.arrayBuffer());
  } catch {
    return Response.json({ error: "unreadable body" }, { status: 400 });
  }

  const result = await handleBatch(body, signedHeadersFrom(request.headers), handlerDeps());
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
