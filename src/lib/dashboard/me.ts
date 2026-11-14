import "server-only";
import { cache } from "react";
import { createServerSupabase } from "@/lib/supabase/server";
import type { Me } from "./types";

/**
 * Who is signed in, with their crew role. Reads the session cookie locally
 * (getSession) rather than calling the auth server, so a GoTrue restart never
 * blanks the page; proxy.ts has already validated the session when it could.
 */
export const getMe = cache(async (): Promise<Me | null> => {
  try {
    const supabase = await createServerSupabase();
    const { data } = await supabase.auth.getSession();
    const userId = data.session?.user.id;
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
