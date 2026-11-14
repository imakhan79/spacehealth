"use client";

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database.types";
import { AUTH_COOKIE_NAME } from "./config";

let client: SupabaseClient<Database> | null = null;

/**
 * The browser talks to the gateway on its own origin, so no Supabase URL is
 * baked into the bundle at build time on Earth. The anon key is handed down
 * at runtime by the server layout.
 */
export function browserSupabase(anonKey: string): SupabaseClient<Database> {
  if (client === null) {
    client = createBrowserClient<Database>(window.location.origin, anonKey, {
      cookieOptions: { name: AUTH_COOKIE_NAME, sameSite: "lax", secure: true, path: "/" },
    });
  }
  return client;
}
