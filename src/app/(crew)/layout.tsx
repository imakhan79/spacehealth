import { Activity, ClipboardList, HeartHandshake, Map as MapIcon } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { ConnectivityProvider } from "@/components/connectivity-provider";
import { NetworkStatus } from "@/components/network-status";
import { getMe } from "@/lib/dashboard/me";
import { serverSupabaseEnv } from "@/lib/supabase/config";
import { SignOutButton } from "./sign-out-button";

export const dynamic = "force-dynamic";

export default async function CrewLayout({ children }: { children: ReactNode }) {
  const { anonKey } = serverSupabaseEnv();
  const me = await getMe();

  return (
    <ConnectivityProvider anonKey={anonKey}>
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3">
          <Link href="/dashboard" className="flex items-center gap-2">
            <Activity className="size-5 text-info" aria-hidden />
            <span className="font-semibold tracking-widest">OMNI</span>
          </Link>
          <div className="order-last w-full sm:order-none sm:ml-4 sm:w-auto sm:max-w-xl sm:flex-1">
            <NetworkStatus />
          </div>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground">
            {me?.callsign && (
              <span>
                <span className="font-semibold text-foreground">{me.callsign}</span>
                {me.role && <span className="hidden sm:inline"> · {me.role.replace("_", " ")}</span>}
              </span>
            )}
            <Link href="/care" className="flex items-center gap-1 hover:text-foreground">
              <HeartHandshake className="size-4" aria-hidden />
              <span className="hidden sm:inline">Care</span>
            </Link>
            <Link href="/habitat" className="flex items-center gap-1 hover:text-foreground">
              <MapIcon className="size-4" aria-hidden />
              <span className="hidden sm:inline">Habitat</span>
            </Link>
            <Link href="/handover" className="flex items-center gap-1 hover:text-foreground">
              <ClipboardList className="size-4" aria-hidden />
              <span className="hidden sm:inline">Handover</span>
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </ConnectivityProvider>
  );
}
