"use client";

import { AlertOctagon, AlertTriangle, Check, CheckCheck, Info, Loader2, ShieldOff, Smartphone } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { canPerform, type AlertAction } from "@/lib/dashboard/alert-mutations";
import type { CrewMember, HealthAlert, Me } from "@/lib/dashboard/types";
import { Ago } from "@/lib/use-now";
import { cn } from "@/lib/utils";

const SEVERITY_RANK = { emergency: 0, warning: 1, caution: 2, advisory: 3 } as const;
const STATUS_RANK = { active: 0, acknowledged: 1, overridden: 2, resolved: 3 } as const;

const SEVERITY_STYLE: Record<HealthAlert["severity"], { variant: "emergency" | "warning" | "caution" | "info"; icon: ReactNode; ring: string }> = {
  emergency: { variant: "emergency", icon: <AlertOctagon aria-hidden />, ring: "border-emergency/60" },
  warning: { variant: "warning", icon: <AlertTriangle aria-hidden />, ring: "border-warning/50" },
  caution: { variant: "caution", icon: <AlertTriangle aria-hidden />, ring: "border-caution/40" },
  advisory: { variant: "info", icon: <Info aria-hidden />, ring: "border-border" },
};

interface Props {
  alerts: HealthAlert[];
  crewById: Map<string, CrewMember>;
  me: Me | null;
  pendingIds: Set<string>;
  stationReachable: boolean;
  onAction: (alert: HealthAlert, action: AlertAction, reason: string | null) => Promise<void>;
}

export function AlertsPanel({ alerts, crewById, me, pendingIds, stationReachable, onAction }: Props) {
  const sorted = [...alerts].sort(
    (a, b) =>
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.triggered_at.localeCompare(a.triggered_at),
  );
  const open = sorted.filter((a) => a.status === "active").length;

  return (
    <section aria-labelledby="alerts-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 id="alerts-heading" className="text-lg font-semibold">
          Health alerts
        </h2>
        <span className="text-sm text-muted-foreground">{open === 0 ? "No open alerts" : `${open} open`}</span>
      </div>
      {sorted.length === 0 ? (
        <Card>
          <CardContent className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <CheckCheck className="size-4 text-ok" aria-hidden /> All crew within limits.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {sorted.map((alert) => (
            <AlertCard
              key={alert.id}
              alert={alert}
              crewById={crewById}
              me={me}
              pending={pendingIds.has(alert.id)}
              stationReachable={stationReachable}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AlertCard({
  alert,
  crewById,
  me,
  pending,
  stationReachable,
  onAction,
}: Omit<Props, "alerts" | "pendingIds"> & { alert: HealthAlert; pending: boolean }) {
  const [overriding, setOverriding] = useState(false);
  const [reason, setReason] = useState("");
  const style = SEVERITY_STYLE[alert.severity];
  const subject = crewById.get(alert.crew_member_id)?.callsign ?? "Crew";
  const callsign = (id: string | null): string => (id ? crewById.get(id)?.callsign ?? "crew" : "crew");

  const ack = me ? canPerform(alert, "acknowledge", me) : null;
  const override = me ? canPerform(alert, "override", me) : null;
  const trimmed = reason.trim();

  return (
    <Card className={cn("flex flex-col", alert.status === "active" ? style.ring : "opacity-80")}>
      <CardHeader className="flex-row items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={style.variant}>
              {style.icon}
              {alert.severity.toUpperCase()}
            </Badge>
            <span className="text-sm font-semibold">{subject}</span>
            <span className="text-xs text-muted-foreground"><Ago iso={alert.triggered_at} /></span>
          </div>
          <CardTitle className="text-sm font-medium leading-snug">{alert.message}</CardTitle>
        </div>
        {pending && (
          <Badge variant={stationReachable ? "info" : "caution"} className="shrink-0">
            {stationReachable ? <Loader2 className="animate-spin" aria-hidden /> : <Smartphone aria-hidden />}
            {stationReachable ? "Saving" : "Held on device"}
          </Badge>
        )}
      </CardHeader>

      <CardContent className="mt-auto flex flex-col gap-3">
        {alert.status === "acknowledged" && (
          <p className="text-xs text-muted-foreground">Acknowledged by {callsign(alert.acknowledged_by)}</p>
        )}
        {alert.status === "overridden" && (
          <p className="text-xs text-muted-foreground">
            <ShieldOff className="mr-1 inline size-3.5" aria-hidden />
            Overridden by {callsign(alert.overridden_by)}: “{alert.override_reason}”
          </p>
        )}

        {(alert.status === "active" || alert.status === "acknowledged") && !overriding && (
          <div className="flex flex-wrap items-center gap-2">
            {ack?.ok && (
              <Button size="sm" variant="outline" onClick={() => void onAction(alert, "acknowledge", null)}>
                <Check aria-hidden /> Acknowledge
              </Button>
            )}
            {override?.ok ? (
              <Button size="sm" variant="outline" onClick={() => setOverriding(true)}>
                <ShieldOff aria-hidden /> Override
              </Button>
            ) : (
              override && <span className="text-xs text-muted-foreground">Override: {override.reason}</span>
            )}
          </div>
        )}

        {overriding && (
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (trimmed.length < 3) return;
              void onAction(alert, "override", trimmed);
              setOverriding(false);
              setReason("");
            }}
          >
            <label className="text-xs text-muted-foreground" htmlFor={`reason-${alert.id}`}>
              Reason for override (logged and sent to Mission Control)
            </label>
            <textarea
              id={`reason-${alert.id}`}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              maxLength={1000}
              autoFocus
              className="rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" type="submit" disabled={trimmed.length < 3}>
                Confirm override
              </Button>
              <Button size="sm" variant="ghost" type="button" onClick={() => setOverriding(false)}>
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
