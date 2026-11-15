// Server and browser reach Supabase through different hostnames (the
// internal gateway vs. the crew LAN origin). @supabase/ssr derives the session
// cookie name from the hostname, so both sides pin the same name explicitly.
export const AUTH_COOKIE_NAME = "sb-omni-auth-token";

export interface ServerSupabaseEnv {
  url: string;
  anonKey: string;
}

export interface DemoLogin {
  email: string;
  password: string;
}

/**
 * Shared demo account for a public ground demo, shown on the login page with
 * a one-click button. Never set on flight hardware: real crew sign in with
 * their own identities.
 */
export function demoLogin(): DemoLogin | null {
  const email = process.env.OMNI_DEMO_EMAIL?.trim();
  const password = process.env.OMNI_DEMO_PASSWORD;
  return email && password ? { email, password } : null;
}

export function serverSupabaseEnv(): ServerSupabaseEnv {
  const url = process.env.OMNI_SUPABASE_INTERNAL_URL;
  const anonKey = process.env.OMNI_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("OMNI_SUPABASE_INTERNAL_URL and OMNI_SUPABASE_ANON_KEY must be set");
  }
  return { url, anonKey };
}
