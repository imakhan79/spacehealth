import type { Enums, Tables } from "@/types/database.types";

export type CrewRole = Enums<"crew_role">;
export type LinkStatus = Enums<"uplink_link_status">;

export type CrewMember = Pick<Tables<"crew_members">, "id" | "callsign" | "full_name" | "role">;
export type HealthAlert = Tables<"health_alerts">;
export type Vital = Pick<Tables<"crew_telemetry">, "id" | "crew_member_id" | "metric" | "value" | "unit" | "recorded_at">;
export type AcousticWindow = Pick<
  Tables<"ambient_acoustics">,
  "id" | "module_id" | "laeq_dba" | "lmax_dba" | "limit_exceeded" | "window_start"
>;

export interface Snapshot {
  crew: CrewMember[];
  alerts: HealthAlert[];
  vitals: Vital[];
  acoustics: AcousticWindow[];
  fetchedAt: string;
}

export interface Me {
  userId: string;
  crewMemberId: string | null;
  callsign: string | null;
  role: CrewRole | null;
}

export const EMPTY_SNAPSHOT: Snapshot = { crew: [], alerts: [], vitals: [], acoustics: [], fetchedAt: "" };
