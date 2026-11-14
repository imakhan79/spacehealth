// Server and browser reach Supabase through different hostnames (the
// internal gateway vs. the crew LAN origin). @supabase/ssr derives the session
// cookie name from the hostname, so both sides pin the same name explicitly.
export const AUTH_COOKIE_NAME = "sb-omni-auth-token";

export interface ServerSupabaseEnv {
  url: string;
  anonKey: string;
}

export function serverSupabaseEnv(): ServerSupabaseEnv {
  const url = process.env.OMNI_SUPABASE_INTERNAL_URL;
  const anonKey = process.env.OMNI_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("OMNI_SUPABASE_INTERNAL_URL and OMNI_SUPABASE_ANON_KEY must be set");
  }
  return { url, anonKey };
}
