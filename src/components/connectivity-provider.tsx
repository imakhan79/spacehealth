"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { loadLinkSummary, type LinkSummary } from "@/lib/dashboard/queries";
import { browserSupabase } from "@/lib/supabase/browser";
import type { Database } from "@/types/database.types";

export type StationState = "unknown" | "reachable" | "unreachable";

interface Connectivity {
  /** Null while server rendering; it is only used in effects and handlers. */
  client: SupabaseClient<Database> | null;
  /** Can this tablet reach the spacecraft server (gateway + database)? */
  station: StationState;
  /** Spacecraft <-> Earth link as last reported by the relay. */
  link: LinkSummary | null;
  /** Local changes not yet confirmed by the spacecraft server. */
  pendingChanges: number;
  reportStation: (reachable: boolean) => void;
  setPendingChanges: (count: number) => void;
}

const ConnectivityContext = createContext<Connectivity | null>(null);

const LINK_POLL_MS = 10_000;

export function ConnectivityProvider({ anonKey, children }: { anonKey: string; children: ReactNode }) {
  // browserSupabase reads window.location, so never build it while server rendering.
  const client = useMemo(() => (typeof window === "undefined" ? null : browserSupabase(anonKey)), [anonKey]);
  const [station, setStation] = useState<StationState>("unknown");
  const [link, setLink] = useState<LinkSummary | null>(null);
  const [pendingChanges, setPendingChanges] = useState(0);

  const reportStation = useCallback((reachable: boolean) => setStation(reachable ? "reachable" : "unreachable"), []);

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    const poll = async (): Promise<void> => {
      try {
        const summary = await loadLinkSummary(client);
        if (cancelled) return;
        setLink(summary);
        setStation("reachable");
      } catch {
        // Keep the last known link state on screen, but say we can't confirm it.
        if (!cancelled) setStation("unreachable");
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), LINK_POLL_MS);
    const onOnline = (): void => void poll();
    const onOffline = (): void => setStation("unreachable");
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
    };
  }, [client]);

  const value = useMemo(
    () => ({ client, station, link, pendingChanges, reportStation, setPendingChanges }),
    [client, station, link, pendingChanges, reportStation],
  );
  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): Connectivity {
  const ctx = useContext(ConnectivityContext);
  if (ctx === null) throw new Error("useConnectivity must be used inside ConnectivityProvider");
  return ctx;
}
