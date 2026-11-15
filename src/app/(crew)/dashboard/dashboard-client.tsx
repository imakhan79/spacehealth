"use client";

import { DatabaseBackup, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConnectivity } from "@/components/connectivity-provider";
import {
  canPerform,
  flushOne,
  overlayPending,
  targetStatus,
  type AlertAction,
  type AlertMutation,
  type WriteResult,
} from "@/lib/dashboard/alert-mutations";
import { loadSnapshot } from "@/lib/dashboard/queries";
import { EMPTY_SNAPSHOT, type HealthAlert, type Me, type Snapshot } from "@/lib/dashboard/types";
import { deleteMutation, readOutbox, readSnapshot, saveMutation, writeSnapshot } from "@/lib/offline/store";
import { clockTime } from "@/lib/utils";
import { AlarmBanner } from "./alarm-banner";
import { AlertsPanel } from "./alerts-panel";
import { CabinAcoustics } from "./cabin-acoustics";
import { CrewVitals } from "./crew-vitals";
import { MessagesPanel } from "./messages-panel";
import { Overview } from "./overview";
import { RadiationPanel } from "./radiation-panel";
import { VitalTrends } from "./vital-trends";
import { HowTo } from "@/components/how-to";

const POLL_MS = 5_000;
const ME_KEY = "omni:me";

interface Notice {
  id: string;
  tone: "info" | "error";
  text: string;
}

function readCachedMe(): Me | null {
  try {
    const raw = window.localStorage.getItem(ME_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "userId" in parsed ? (parsed as Me) : null;
  } catch {
    return null;
  }
}

function upsertAlert(snapshot: Snapshot, row: HealthAlert): Snapshot {
  const exists = snapshot.alerts.some((a) => a.id === row.id);
  return {
    ...snapshot,
    alerts: exists ? snapshot.alerts.map((a) => (a.id === row.id ? row : a)) : [row, ...snapshot.alerts],
  };
}

export function DashboardClient({
  initial,
  serverError,
  me: serverMe,
  demoMode,
}: {
  initial: Snapshot | null;
  serverError: string | null;
  me: Me | null;
  /** Ground demo: shows demo-only controls such as the storm drill. */
  demoMode: boolean;
}) {
  const { client, station, reportStation, setPendingChanges } = useConnectivity();
  const [me, setMe] = useState<Me | null>(serverMe);
  const [snapshot, setSnapshot] = useState<Snapshot>(initial ?? EMPTY_SNAPSHOT);
  const [source, setSource] = useState<"live" | "cache" | "none">(initial ? "live" : "none");
  const [outbox, setOutbox] = useState<AlertMutation[]>([]);
  const [notices, setNotices] = useState<Notice[]>([]);

  const outboxRef = useRef<AlertMutation[]>([]);
  const flushing = useRef(false);
  const userId = me?.userId ?? null;

  const notify = useCallback((tone: Notice["tone"], text: string) => {
    setNotices((n) => [...n.slice(-3), { id: crypto.randomUUID(), tone, text }]);
  }, []);

  const replaceOutbox = useCallback(
    (next: AlertMutation[]) => {
      outboxRef.current = next;
      setOutbox(next);
      setPendingChanges(next.length);
    },
    [setPendingChanges],
  );

  // --- Identity survives a server outage --------------------------------------
  useEffect(() => {
    if (serverMe?.role) {
      try {
        window.localStorage.setItem(ME_KEY, JSON.stringify(serverMe));
      } catch {
        // storage blocked; identity just won't survive a reload while offline
      }
    } else {
      const cached = readCachedMe();
      if (cached && (!serverMe || cached.userId === serverMe.userId)) setMe(cached);
    }
  }, [serverMe]);

  // --- Boot: cached snapshot (if the server render failed) + durable outbox ----
  useEffect(() => {
    if (userId === null) return;
    let cancelled = false;
    void (async () => {
      if (initial) {
        await writeSnapshot(userId, initial);
      } else {
        const cached = await readSnapshot(userId);
        if (!cancelled && cached) {
          setSnapshot(cached);
          setSource("cache");
        }
      }
      const pending = await readOutbox();
      if (!cancelled) replaceOutbox(pending);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, initial, replaceOutbox]);

  // --- Write path ---------------------------------------------------------------
  const write = useCallback(
    async (m: AlertMutation): Promise<WriteResult> => {
      // status 0 = retryable: the change stays in the outbox.
      if (client === null) return { kind: "error", status: 0, code: "", message: "Supabase client not ready" };
      const patch = m.action === "override" ? { status: targetStatus(m.action), override_reason: m.reason } : { status: targetStatus(m.action) };
      const res = await client
        .from("health_alerts")
        .update(patch)
        .eq("id", m.alertId)
        .eq("row_version", m.baseVersion) // optimistic concurrency
        .select("*");
      if (res.error) return { kind: "error", status: res.status, code: res.error.code ?? "", message: res.error.message };
      const row = res.data[0];
      if (row) return { kind: "applied", row };

      const current = await client.from("health_alerts").select("*").eq("id", m.alertId).maybeSingle();
      if (current.error) return { kind: "error", status: current.status, code: current.error.code ?? "", message: current.error.message };
      return { kind: "stale", current: current.data };
    },
    [client],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (flushing.current || outboxRef.current.length === 0) return;
    flushing.current = true;
    try {
      let queue = [...outboxRef.current];
      while (queue.length > 0) {
        const mutation = queue[0];
        if (!mutation) break;
        const outcome = await flushOne(mutation, write);

        if (outcome.kind === "kept") {
          await saveMutation(outcome.mutation);
          queue = [outcome.mutation, ...queue.slice(1)];
          replaceOutbox(queue);
          reportStation(false);
          break; // keep order; retry on the next poll
        }

        await deleteMutation(mutation.id);
        queue = queue.slice(1);

        if (outcome.kind === "confirmed") {
          const row = outcome.row;
          setSnapshot((s) => upsertAlert(s, row));
          // Later edits to the same alert were based on the old version.
          queue = queue.map((m) => (m.alertId === row.id ? { ...m, baseVersion: row.row_version } : m));
          for (const m of queue) if (m.alertId === row.id) await saveMutation(m);
          reportStation(true);
        } else if (outcome.kind === "rejected") {
          notify("error", `Not saved: ${outcome.reason}`);
        } else {
          const current = outcome.current;
          if (current) setSnapshot((s) => upsertAlert(s, current));
          notify("info", `This alert changed on another device (now ${current?.status ?? "unknown"}). Your change was not applied; review and retry if still needed.`);
        }
        replaceOutbox(queue);
      }
    } finally {
      flushing.current = false;
    }
  }, [write, replaceOutbox, reportStation, notify]);

  const perform = useCallback(
    async (alert: HealthAlert, action: AlertAction, reason: string | null): Promise<void> => {
      if (me === null) return;
      const allowed = canPerform(alert, action, me);
      if (!allowed.ok) {
        notify("error", allowed.reason);
        return;
      }
      const mutation: AlertMutation = {
        id: crypto.randomUUID(),
        alertId: alert.id,
        action,
        reason,
        baseVersion: alert.row_version,
        createdAt: new Date().toISOString(),
        attempts: 0,
        lastError: null,
      };
      // Durable first (survives a tab crash), then visible, then sent.
      await saveMutation(mutation);
      replaceOutbox([...outboxRef.current, mutation]);
      await flush();
    },
    [me, notify, replaceOutbox, flush],
  );

  // --- Live refresh ---------------------------------------------------------------
  const refresh = useCallback(async (): Promise<void> => {
    if (client === null) return;
    try {
      const next = await loadSnapshot(client);
      setSnapshot(next);
      setSource("live");
      reportStation(true);
      if (userId) await writeSnapshot(userId, next);
      await flush();
    } catch {
      reportStation(false);
      setSource((s) => (s === "none" ? "none" : "cache"));
    }
  }, [client, userId, reportStation, flush]);

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), POLL_MS);
    const onOnline = (): void => void refresh();
    window.addEventListener("online", onOnline);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", onOnline);
    };
  }, [refresh]);

  // --- Render ---------------------------------------------------------------------
  const alerts = useMemo(() => (me ? overlayPending(snapshot.alerts, outbox, me) : snapshot.alerts), [snapshot.alerts, outbox, me]);
  const pendingIds = useMemo(() => new Set(outbox.map((m) => m.alertId)), [outbox]);
  const crewById = useMemo(() => new Map(snapshot.crew.map((c) => [c.id, c])), [snapshot.crew]);

  return (
    <div className="flex flex-col gap-6">
      {(source === "cache" || (source === "none" && serverError)) && (
        <div className="flex items-start gap-3 rounded-lg border border-caution/40 bg-caution/10 px-4 py-3 text-sm text-caution">
          <DatabaseBackup className="mt-0.5 size-4 shrink-0" aria-hidden />
          <p>
            {source === "cache"
              ? `Station server not responding. Showing data cached on this device at ${snapshot.fetchedAt ? clockTime(snapshot.fetchedAt) : "unknown time"}; retrying every ${POLL_MS / 1000}s.`
              : "Station server not responding and no cached data on this device yet. Retrying…"}
          </p>
        </div>
      )}

      {notices.length > 0 && (
        <ul className="flex flex-col gap-2" aria-live="assertive">
          {notices.map((n) => (
            <li
              key={n.id}
              className={
                n.tone === "error"
                  ? "flex items-start justify-between gap-3 rounded-lg border border-emergency/40 bg-emergency/10 px-4 py-2 text-sm text-emergency"
                  : "flex items-start justify-between gap-3 rounded-lg border border-info/40 bg-info/10 px-4 py-2 text-sm text-info"
              }
            >
              <span>{n.text}</span>
              <button aria-label="Dismiss" onClick={() => setNotices((all) => all.filter((x) => x.id !== n.id))}>
                <X className="size-4" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      <AlarmBanner alerts={alerts} crewById={crewById} me={me} pendingIds={pendingIds} onAction={perform} />

      <Overview crew={snapshot.crew} vitals={snapshot.vitals} alerts={alerts} acoustics={snapshot.acoustics} me={me?.callsign ?? null} />

      <HowTo page="dashboard" />

      <CrewVitals crew={snapshot.crew} vitals={snapshot.vitals} />

      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-6 lg:col-span-2">
      <AlertsPanel
        alerts={alerts}
        crewById={crewById}
        me={me}
        pendingIds={pendingIds}
        stationReachable={station !== "unreachable"}
        onAction={perform}
      />

          <VitalTrends crew={snapshot.crew} vitals={snapshot.vitals} me={me} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <MessagesPanel crewById={crewById} me={me} />
          <RadiationPanel crew={snapshot.crew} vitals={snapshot.vitals} demoMode={demoMode} />
          <CabinAcoustics windows={snapshot.acoustics} />
        </div>
      </div>
    </div>
  );
}
