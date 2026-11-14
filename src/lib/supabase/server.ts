import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies, headers } from "next/headers";
import type { Database } from "@/types/database.types";
import { AUTH_COOKIE_NAME, serverSupabaseEnv } from "./config";

export type OmniClient = SupabaseClient<Database>;

/** Request-scoped client for Server Components and Server Actions. */
export async function createServerSupabase(): Promise<OmniClient> {
  const { url, anonKey } = serverSupabaseEnv();
  const cookieStore = await cookies();
  const requestHeaders = await headers();
  // Forward the crew device's address so GoTrue rate-limits per device,
  // not per web container (the gateway trusts this on its internal port).
  const deviceIp = requestHeaders.get("x-real-ip") ?? requestHeaders.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";

  return createServerClient<Database>(url, anonKey, {
    cookieOptions: { name: AUTH_COOKIE_NAME, sameSite: "lax", secure: true, path: "/" },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          for (const { name, value, options } of toSet) cookieStore.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; proxy.ts refreshes them instead.
        }
      },
    },
    global: { headers: deviceIp ? { "X-Real-IP": deviceIp } : {} },
  });
}
