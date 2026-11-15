"use server";

import { demoLogin } from "@/lib/supabase/config";
import { createServerSupabase } from "@/lib/supabase/server";

export type DrillResult = { ok: true; startedAt: string } | { ok: false; error: string };

/**
 * Ground demo only: start a solar storm drill. The database function exists
 * only in the demo database (scripts/demo-live-vitals.sql), and this action
 * refuses to run unless the demo login is configured.
 */
export async function runSolarDrill(): Promise<DrillResult> {
  if (demoLogin() === null) return { ok: false, error: "Drills are only available in the demo." };
  try {
    const db = await createServerSupabase();
    const { data, error } = await db.rpc("demo_solar_drill");
    if (error) return { ok: false, error: error.message };
    return { ok: true, startedAt: String(data) };
  } catch {
    return { ok: false, error: "Station server unreachable." };
  }
}
