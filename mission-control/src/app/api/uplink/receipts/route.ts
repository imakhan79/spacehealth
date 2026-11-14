import { handlerDeps } from "@/lib/config";
import { handleReceipts, signedHeadersFrom } from "@/lib/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  let body: Uint8Array;
  try {
    body = new Uint8Array(await request.arrayBuffer());
  } catch {
    return Response.json({ error: "unreadable body" }, { status: 400 });
  }

  const result = await handleReceipts(body, signedHeadersFrom(request.headers), handlerDeps());
  return Response.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
