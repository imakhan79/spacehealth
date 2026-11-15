import "server-only";
import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";
import type { Me } from "./types";

/** The `sub` claim of a JWT, without verifying it (see getMe for why that's fine here). */
function subjectOf(jwt: string): string | null {
  try {
    const payload: unknown = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload === "object" && payload !== null && "sub" in payload && typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

/**
 * Who is signed in, with their crew role. Reads the session cookie locally
 * (getSession) rather than calling the auth server, so a GoTrue restart never
 * blanks the page; proxy.ts has already validated the session when it could.
 *
 * Identity here only picks what to *display*. Every query below runs with the
 * session's access token, which PostgREST verifies and RLS enforces, so a
 * forged cookie gets nothing. We take the user id from that token rather than
 * from session.user, which supabase-js flags as unverified cookie data.
 */
export const getMe = cache(async (): Promise<Me | null> => {
  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    const userId = token ? subjectOf(token) : null;
    if (!userId) return null;

    const { data: member } = await supabase
      .from("crew_members")
      .select("id, callsign, role")
      .eq("auth_user_id", userId)
      .maybeSingle();

    return {
      userId,
      crewMemberId: member?.id ?? null,
      callsign: member?.callsign ?? null,
      role: member?.role ?? null,
    };
  } catch {
    return null;
  }
});
