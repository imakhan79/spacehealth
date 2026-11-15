import { Activity } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ConnectivityProvider } from "@/components/connectivity-provider";
import { NetworkStatus } from "@/components/network-status";
import { getMe } from "@/lib/dashboard/me";
import { demoLogin, serverSupabaseEnv } from "@/lib/supabase/config";
import { NowProvider } from "@/lib/use-now";
import { NavLinks } from "./nav-links";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

export default async function CrewLayout({ children }: { children: ReactNode }) {
  const { anonKey } = serverSupabaseEnv();
  const me = await getMe();

  return (
    <NowProvider>
    <ConnectivityProvider anonKey={anonKey}>
      <header className="sticky top-0 z-10 border-b border-border/80 bg-background/85 backdrop-blur-md print:hidden">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <Link href="/dashboard" className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-info/15 ring-1 ring-info/30">
              <Activity className="size-5 text-info" aria-hidden />
            </span>
            <span className="font-semibold tracking-[0.25em]">OMNI</span>
          </Link>
          <div className="order-last w-full sm:order-none sm:ml-4 sm:w-auto sm:max-w-xl sm:flex-1">
            <NetworkStatus />
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
            {me?.callsign && (
              <span className="flex items-center gap-2">
                <span className="flex size-7 items-center justify-center rounded-full bg-gradient-to-br from-series/40 to-muted text-[11px] font-bold text-foreground" aria-hidden>
                  {me.callsign.slice(0, 3)}
                </span>
                <span>
                  <span className="font-semibold text-foreground">{me.callsign}</span>
                  {me.role && <span className="hidden sm:inline"> · {me.role.replace("_", " ")}</span>}
                </span>
              </span>
            )}
            {/* Ground demo opens with no login, so there is nothing to sign out of. */}
            {demoLogin() === null && <SignOutButton />}
          </div>
        </div>
        <div className="mx-auto max-w-7xl px-4">
          <NavLinks />
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </ConnectivityProvider>
    </NowProvider>
  );
}
