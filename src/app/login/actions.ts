"use server";

import { redirect } from "next/navigation";
import { createServerSupabase } from "@/lib/supabase/server";

export interface LoginState {
  error: string | null;
}

export async function signIn(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Enter your crew email and password." };

  try {
    const supabase = await createServerSupabase();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      // Status 0 / 5xx = auth server unreachable; 4xx = wrong credentials or rate limit.
      if (!error.status || error.status >= 500) {
        return { error: "Station authentication service is not responding. Try again in a moment." };
      }
      return { error: error.status === 429 ? "Too many attempts. Wait a minute." : "Email or password not recognised." };
    }
  } catch {
    return { error: "Station server unreachable. Check the tablet's station Wi-Fi." };
  }

  redirect("/dashboard");
}

export async function signOut(): Promise<void> {
  try {
    const supabase = await createServerSupabase();
    await supabase.auth.signOut({ scope: "local" });
  } catch {
    // Even if auth is unreachable, the client clears its own cookie/cache.
  }
  redirect("/login");
}
