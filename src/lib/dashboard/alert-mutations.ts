// Pure logic for optimistic alert dispositions and their outbox. No React,
// no network: the caller injects the writer, so this is unit-tested directly.
import type { HealthAlert, Me } from "./types";

export type AlertAction = "acknowledge" | "override";

export interface AlertMutation {
  id: string;
  alertId: string;
  action: AlertAction;
  reason: string | null;
  /** row_version the crew member saw; the write only applies if unchanged. */
  baseVersion: number;
  createdAt: string;
  attempts: number;
  lastError: string | null;
}

export function targetStatus(action: AlertAction): "acknowledged" | "overridden" {
  return action === "acknowledge" ? "acknowledged" : "overridden";
}

/** Mirrors the server rule in tg_health_alert_guard for instant UI feedback. The server stays authoritative. */
export function canPerform(alert: HealthAlert, action: AlertAction, me: Me): { ok: true } | { ok: false; reason: string } {
  if (me.role === null || me.role === "sensor_gateway") return { ok: false, reason: "No crew identity" };
  const oversight = me.role === "flight_surgeon" || me.role === "commander";
  if (alert.crew_member_id !== me.crewMemberId && !oversight) return { ok: false, reason: "Not your alert" };
  if (action === "acknowledge" && alert.status !== "active") return { ok: false, reason: "Already handled" };
  if (action === "override") {
    if (alert.status !== "active" && alert.status !== "acknowledged") return { ok: false, reason: "Already handled" };
    if ((alert.severity === "warning" || alert.severity === "emergency") && !oversight) {
      return { ok: false, reason: "Requires flight surgeon or commander" };
    }
  }
  return { ok: true };
}

/** What the crew member should see immediately, before the server confirms. */
export function applyOptimistic(alert: HealthAlert, mutation: AlertMutation, me: Me): HealthAlert {
  if (mutation.action === "acknowledge") {
    return { ...alert, status: "acknowledged", acknowledged_by: me.crewMemberId, acknowledged_at: mutation.createdAt };
  }
  return {
    ...alert,
    status: "overridden",
    override_reason: mutation.reason,
    overridden_by: me.crewMemberId,
    overridden_at: mutation.createdAt,
  };
}

/** Overlay every pending mutation on the latest server data, oldest first. */
export function overlayPending(alerts: HealthAlert[], outbox: AlertMutation[], me: Me): HealthAlert[] {
  if (outbox.length === 0) return alerts;
  return alerts.map((alert) =>
    outbox.filter((m) => m.alertId === alert.id).reduce((acc, m) => applyOptimistic(acc, m, me), alert),
  );
}

export type WriteResult =
  | { kind: "applied"; row: HealthAlert }
  /** 0 rows matched: row_version moved on (another device, the gateway, or our own lost reply). */
  | { kind: "stale"; current: HealthAlert | null }
  | { kind: "error"; status: number; code: string; message: string };

export type FlushOutcome =
  | { kind: "confirmed"; mutation: AlertMutation; row: HealthAlert }
  | { kind: "kept"; mutation: AlertMutation; error: string }
  | { kind: "rejected"; mutation: AlertMutation; reason: string }
  | { kind: "superseded"; mutation: AlertMutation; current: HealthAlert | null };

/**
 * Transport problems (no HTTP status, gateway 5xx, rate limit) keep the
 * mutation for retry. Anything the database itself refused is final.
 */
export function isTransient(result: { status: number; code: string }): boolean {
  return result.status === 0 || result.status === 408 || result.status === 429 || result.status >= 500;
}

export async function flushOne(
  mutation: AlertMutation,
  write: (m: AlertMutation) => Promise<WriteResult>,
): Promise<FlushOutcome> {
  let result: WriteResult;
  try {
    result = await write(mutation);
  } catch (error) {
    return { kind: "kept", mutation: bump(mutation, describe(error)), error: describe(error) };
  }

  switch (result.kind) {
    case "applied":
      return { kind: "confirmed", mutation, row: result.row };
    case "stale":
      // If the server already shows what we wanted (e.g. our earlier attempt
      // landed but its reply was lost), that is a success, not a conflict.
      if (result.current !== null && result.current.status === targetStatus(mutation.action)) {
        return { kind: "confirmed", mutation, row: result.current };
      }
      return { kind: "superseded", mutation, current: result.current };
    case "error":
      if (isTransient(result)) return { kind: "kept", mutation: bump(mutation, result.message), error: result.message };
      return { kind: "rejected", mutation, reason: result.message };
  }
}

function bump(mutation: AlertMutation, error: string): AlertMutation {
  return { ...mutation, attempts: mutation.attempts + 1, lastError: error };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
