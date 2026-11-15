import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

// Ground-team pages show crew medical data, so every page sits behind a
// login. The uplink API is excluded: it authenticates each request itself
// with the spacecraft's HMAC signature.
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function matches(given: string, expected: string): boolean {
  return timingSafeEqual(digest(given), digest(expected));
}

export function proxy(request: NextRequest): NextResponse {
  const user = process.env.MISSION_CONTROL_USER;
  const password = process.env.MISSION_CONTROL_PASSWORD;
  if (!user || !password) {
    return new NextResponse("Mission Control login is not configured.", { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const split = decoded.indexOf(":");
    if (split > 0 && matches(decoded.slice(0, split), user) && matches(decoded.slice(split + 1), password)) {
      return NextResponse.next();
    }
  }

  return new NextResponse("Authentication required.", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="OMNI Mission Control", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ["/((?!api/uplink/|_next/static|_next/image|favicon\\.ico).*)"],
};
