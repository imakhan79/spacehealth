"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { timeAgo } from "./utils";

// The server and the browser read the clock at different moments, so anything
// rendered from Date.now() during the first paint differs between them and
// React aborts hydration. One shared clock fixes that at the root: it is null
// on the server and during hydration, then live (ticking) right after.

const NowContext = createContext<number | null>(null);

export function NowProvider({ children, tickMs = 5_000 }: { children: ReactNode; tickMs?: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), tickMs);
    return () => window.clearInterval(t);
  }, [tickMs]);
  return <NowContext.Provider value={now}>{children}</NowContext.Provider>;
}

/** Current time, or null until the page has hydrated. */
export function useNow(): number | null {
  return useContext(NowContext);
}

/** "3m ago" once hydrated; the exact UTC time before that (same on server and client). */
export function Ago({ iso, prefix = "" }: { iso: string | null; prefix?: string }) {
  const now = useNow();
  if (!iso) return <span>never</span>;
  return (
    <time dateTime={iso} title={new Date(iso).toISOString().replace("T", " ").slice(0, 19) + "Z"}>
      {prefix}
      {now === null ? `${new Date(iso).toISOString().slice(11, 16)}Z` : timeAgo(iso, now)}
    </time>
  );
}
