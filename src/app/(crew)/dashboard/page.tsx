import { getMe } from "@/lib/dashboard/me";
import { loadSnapshot } from "@/lib/dashboard/queries";
import type { Snapshot } from "@/lib/dashboard/types";
import { demoLogin } from "@/lib/supabase/config";
import { createServerSupabase } from "@/lib/supabase/server";
import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";

// Server Component: first paint straight from the local database. If the
// database is unreachable the page still renders; the client then serves the
// last snapshot cached on this device and keeps retrying.
export default async function DashboardPage() {
  const me = await getMe();

  let initial: Snapshot | null = null;
  let serverError: string | null = null;
  try {
    initial = await loadSnapshot(await createServerSupabase());
  } catch (error) {
    serverError = error instanceof Error ? error.message : String(error);
  }

  return <DashboardClient initial={initial} serverError={serverError} me={me} demoMode={demoLogin() !== null} />;
}
