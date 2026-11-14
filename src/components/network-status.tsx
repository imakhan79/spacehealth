"use client";

import { AlertTriangle, HardDrive, SatelliteDish, ServerOff } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { cn, timeAgo } from "@/lib/utils";
import { useConnectivity } from "./connectivity-provider";

interface View {
  label: string;
  detail: string;
  icon: ReactNode;
  tone: string;
}

/**
 * Global indicator. The crew must always know two independent things:
 * is my data safe aboard (station), and is Earth receiving it (uplink)?
 */
export function NetworkStatus() {
  const { station, link, pendingChanges } = useConnectivity();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const queued = link?.queuedForEarth ?? 0;
  let view: View;

  if (station === "unreachable") {
    view = {
      label: "Station server unreachable",
      detail:
        pendingChanges > 0
          ? `Showing cached data · ${pendingChanges} change${pendingChanges === 1 ? "" : "s"} held on this device`
          : "Showing cached data from this device",
      icon: <ServerOff aria-hidden />,
      tone: "border-emergency/50 bg-emergency/15 text-emergency",
    };
  } else if (link?.status === "uplink_active") {
    view = {
      label: "Earth Uplink Active",
      detail: `Last contact ${timeAgo(link.lastContactAt, now)}${link.rttMs !== null ? ` · RTT ${(link.rttMs / 1000).toFixed(1)}s` : ""}${queued > 0 ? ` · ${queued} sending` : ""}`,
      icon: <SatelliteDish aria-hidden />,
      tone: "border-ok/40 bg-ok/15 text-ok",
    };
  } else if (link?.status === "degraded") {
    view = {
      label: "Uplink Degraded",
      detail: `Earth reachable but not accepting data · ${queued} queued aboard`,
      icon: <AlertTriangle aria-hidden />,
      tone: "border-caution/40 bg-caution/15 text-caution",
    };
  } else {
    view = {
      label: "Local Mode",
      detail:
        link === null
          ? "Connecting to station server…"
          : `No Earth link · all data saved aboard · ${queued} queued for Earth · last contact ${timeAgo(link.lastContactAt, now)}`,
      icon: <HardDrive aria-hidden />,
      tone: "border-info/40 bg-info/15 text-info",
    };
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex min-w-0 items-center gap-3 rounded-lg border px-3 py-2 [&_svg]:size-5 [&_svg]:shrink-0", view.tone)}
    >
      {view.icon}
      <div className="min-w-0">
        <div className="text-sm font-semibold leading-tight">{view.label}</div>
        <div className="truncate text-xs opacity-90">{view.detail}</div>
      </div>
    </div>
  );
}
