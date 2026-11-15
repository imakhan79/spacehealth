import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import type { Database } from "@/types/database.types";
import { AUTH_COOKIE_NAME, demoLogin } from "@/lib/supabase/config";

// Refreshes the crew session and guards app routes.
//
// Life-critical rule: only send someone to /login when the auth server
// *positively* says the session is invalid. If GoTrue is merely unreachable
// (restarting, overloaded), let the request through so the dashboard can
// render cached data instead of locking the crew out.
export async function proxy(request: NextRequest): Promise<NextResponse> {
  const url = process.env.OMNI_SUPABASE_INTERNAL_URL;
  const anonKey = process.env.OMNI_SUPABASE_ANON_KEY;
  let response = NextResponse.next({ request });
  if (!url || !anonKey) return response;

  const hasSessionCookie = request.cookies.getAll().some((c) => c.name.startsWith(AUTH_COOKIE_NAME));
  const isLogin = request.nextUrl.pathname.startsWith("/login");
  // The home page is public (it only describes OMNI and links to sign-in).
  const isPublic = isLogin || request.nextUrl.pathname === "/";

  const supabase = createServerClient<Database>(url, anonKey, {
    cookieOptions: { name: AUTH_COOKIE_NAME, sameSite: "lax", secure: true, path: "/" },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });

  if (!hasSessionCookie) {
    if (isPublic) return response;
    // Ground demo only: open the app with no login form by signing the visitor
    // in as the shared demo account. It is still a real session, so every
    // query carries a token PostgREST verifies and RLS enforces. Never set on
    // flight hardware, where crew sign in with their own identities.
    const demo = demoLogin();
    if (demo) {
      try {
        const { error } = await supabase.auth.signInWithPassword(demo);
        // The new session cookies are on both the request and the response
        // (setAll above), so this same request renders signed in.
        if (!error) return response;
      } catch {
        // Fall through to the login page.
      }
    }
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    return NextResponse.redirect(login);
  }

  try {
    const { data, error } = await supabase.auth.getUser();
    const definitelyInvalid = error !== null && typeof error.status === "number" && error.status >= 400 && error.status < 500;
    // Demo: an expired demo session simply signs in again.
    const demo = demoLogin();
    if (definitelyInvalid && !isPublic && demo) {
      const { error: again } = await supabase.auth.signInWithPassword(demo);
      if (!again) return response;
    }
    if (definitelyInvalid && !isPublic) {
      const login = request.nextUrl.clone();
      login.pathname = "/login";
      return NextResponse.redirect(login);
    }
    if (data.user !== null && isLogin) {
      const dashboard = request.nextUrl.clone();
      dashboard.pathname = "/dashboard";
      return NextResponse.redirect(dashboard);
    }
  } catch {
    // Auth server unreachable: fail open to cached data, never to a lockout.
  }

  return response;
}

export const config = {
  // auth/v1 and rest/v1 are Supabase's own APIs (gateway aboard, rewrites on a
  // ground demo); they authenticate themselves and must never redirect.
  matcher: ["/((?!_next/static|_next/image|sw\\.js|manifest\\.webmanifest|icon\\.svg|api/health|auth/v1/|rest/v1/).*)"],
};
