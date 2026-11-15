// Mirrors supabase/migrations/*.sql (core schema, uplink relay, ground messages, crew care).
// Once the local stack is up (Phase 2), regenerate with:
//   supabase gen types typescript --db-url "$OMNI_DB_URL" --schema public > src/types/database.types.ts

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

type SyncRow = {
  hold_onboard: boolean
  deleted_at: string | null
  sync_status: Database["public"]["Enums"]["sync_status"]
  last_modified_at: string
  row_version: number
  earth_ack_version: number
  origin_node: Database["public"]["Enums"]["node_origin"]
  synced_at: string | null
}

// Sync bookkeeping is trigger-owned; clients may only request a privacy hold.
type SyncInsert = {
  hold_onboard?: boolean
  deleted_at?: string | null
  sync_status?: Database["public"]["Enums"]["sync_status"]
  last_modified_at?: string
  row_version?: number
  earth_ack_version?: number
  origin_node?: Database["public"]["Enums"]["node_origin"]
  synced_at?: string | null
}

export type Database = {
  public: {
    Tables: {
      crew_members: {
        Row: {
          id: string
          auth_user_id: string
          callsign: string
          full_name: string
          role: Database["public"]["Enums"]["crew_role"]
          is_active: boolean
          created_at: string
        } & SyncRow
        Insert: {
          id?: string
          auth_user_id: string
          callsign: string
          full_name: string
          role?: Database["public"]["Enums"]["crew_role"]
          is_active?: boolean
          created_at?: string
        } & SyncInsert
        Update: {
          id?: string
          auth_user_id?: string
          callsign?: string
          full_name?: string
          role?: Database["public"]["Enums"]["crew_role"]
          is_active?: boolean
          created_at?: string
        } & SyncInsert
        Relationships: []
      }
      crew_telemetry: {
        Row: {
          id: string
          crew_member_id: string
          metric: Database["public"]["Enums"]["telemetry_metric"]
          value: number
          unit: string
          recorded_at: string
          device_id: string
          signal_quality: number | null
          created_at: string
        } & SyncRow
        Insert: {
          id?: string
          crew_member_id: string
          metric: Database["public"]["Enums"]["telemetry_metric"]
          value: number
          unit: string
          recorded_at: string
          device_id: string
          signal_quality?: number | null
          created_at?: string
        } & SyncInsert
        Update: {
          id?: string
          crew_member_id?: string
          metric?: Database["public"]["Enums"]["telemetry_metric"]
          value?: number
          unit?: string
          recorded_at?: string
          device_id?: string
          signal_quality?: number | null
          created_at?: string
        } & SyncInsert
        Relationships: [
          {
            foreignKeyName: "crew_telemetry_crew_member_id_fkey"
            columns: ["crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
        ]
      }
      health_alerts: {
        Row: {
          id: string
          crew_member_id: string
          telemetry_id: string | null
          metric: Database["public"]["Enums"]["telemetry_metric"] | null
          severity: Database["public"]["Enums"]["alert_severity"]
          status: Database["public"]["Enums"]["alert_status"]
          message: string
          triggered_at: string
          acknowledged_by: string | null
          acknowledged_at: string | null
          overridden_by: string | null
          overridden_at: string | null
          override_reason: string | null
          resolved_at: string | null
          created_at: string
        } & SyncRow
        Insert: {
          id?: string
          crew_member_id: string
          telemetry_id?: string | null
          metric?: Database["public"]["Enums"]["telemetry_metric"] | null
          severity: Database["public"]["Enums"]["alert_severity"]
          status?: Database["public"]["Enums"]["alert_status"]
          message: string
          triggered_at?: string
          acknowledged_by?: string | null
          acknowledged_at?: string | null
          overridden_by?: string | null
          overridden_at?: string | null
          override_reason?: string | null
          resolved_at?: string | null
          created_at?: string
        } & SyncInsert
        // Column grants: authenticated clients may only update these two.
        Update: {
          status?: Database["public"]["Enums"]["alert_status"]
          override_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "health_alerts_crew_member_id_fkey"
            columns: ["crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "health_alerts_telemetry_id_fkey"
            columns: ["telemetry_id"]
            isOneToOne: false
            referencedRelation: "crew_telemetry"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "health_alerts_acknowledged_by_fkey"
            columns: ["acknowledged_by"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "health_alerts_overridden_by_fkey"
            columns: ["overridden_by"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
        ]
      }
      // supabase/migrations/20261115000400_crew_care.sql
      wellness_checkins: {
        Row: {
          id: string
          crew_member_id: string
          checkin_date: string
          sleep_hours: number
          fatigue: number
          mood: number
          symptoms: string[]
          note: string | null
          updated_at: string
        }
        Insert: {
          id?: string
          crew_member_id?: string
          checkin_date?: string
          sleep_hours: number
          fatigue: number
          mood: number
          symptoms?: string[]
          note?: string | null
          updated_at?: string
        }
        Update: {
          sleep_hours?: number
          fatigue?: number
          mood?: number
          symptoms?: string[]
          note?: string | null
        }
        Relationships: []
      }
      medications: {
        Row: {
          id: string
          crew_member_id: string
          name: string
          dose: string
          instructions: string | null
          schedule_utc: string[]
          active: boolean
          prescribed_by: string | null
          created_at: string
        }
        Insert: {
          id?: string
          crew_member_id: string
          name: string
          dose: string
          instructions?: string | null
          schedule_utc: string[]
          active?: boolean
          prescribed_by?: string | null
          created_at?: string
        }
        Update: {
          active?: boolean
          instructions?: string | null
        }
        Relationships: []
      }
      medication_doses: {
        Row: {
          id: string
          medication_id: string
          crew_member_id: string
          due_at: string
          taken_at: string
        }
        Insert: {
          id?: string
          medication_id: string
          crew_member_id?: string
          due_at: string
          taken_at?: string
        }
        Update: Record<string, never>
        Relationships: []
      }
      medical_inventory: {
        Row: {
          id: string
          item: string
          category: string
          quantity: number
          unit: string
          min_quantity: number
          expires_on: string | null
          location: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          id?: string
          item: string
          category: string
          quantity: number
          unit: string
          min_quantity?: number
          expires_on?: string | null
          location: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          quantity?: number
        }
        Relationships: []
      }
      exercise_prescriptions: {
        Row: {
          crew_member_id: string
          kind: Database["public"]["Enums"]["exercise_kind"]
          weekly_minutes: number
        }
        Insert: {
          crew_member_id: string
          kind: Database["public"]["Enums"]["exercise_kind"]
          weekly_minutes: number
        }
        Update: Record<string, never>
        Relationships: []
      }
      exercise_sessions: {
        Row: {
          id: string
          crew_member_id: string
          kind: Database["public"]["Enums"]["exercise_kind"]
          minutes: number
          performed_at: string
          note: string | null
        }
        Insert: {
          id?: string
          crew_member_id?: string
          kind: Database["public"]["Enums"]["exercise_kind"]
          minutes: number
          performed_at?: string
          note?: string | null
        }
        Update: Record<string, never>
        Relationships: []
      }
      crew_locations: {
        Row: {
          crew_member_id: string
          module_id: string
          updated_at: string
        }
        Insert: {
          crew_member_id?: string
          module_id: string
          updated_at?: string
        }
        Update: {
          module_id?: string
        }
        Relationships: []
      }
      // supabase/migrations/20261115000300_ground_messages.sql
      ground_messages: {
        Row: {
          id: string
          author: string
          priority: Database["public"]["Enums"]["message_priority"]
          recipient_crew_id: string | null
          subject: string
          body: string
          sent_at: string
          received_at: string
        }
        // Written aboard only by the relay.
        Insert: {
          id?: string
          author: string
          priority?: Database["public"]["Enums"]["message_priority"]
          recipient_crew_id?: string | null
          subject: string
          body: string
          sent_at: string
          received_at?: string
        }
        Update: Record<string, never>
        Relationships: [
          {
            foreignKeyName: "ground_messages_recipient_crew_id_fkey"
            columns: ["recipient_crew_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
        ]
      }
      ground_message_reads: {
        Row: {
          message_id: string
          crew_member_id: string
          read_at: string
        }
        // crew_member_id and read_at are stamped server-side.
        Insert: {
          message_id: string
          crew_member_id?: string
          read_at?: string
        }
        Update: Record<string, never>
        Relationships: [
          {
            foreignKeyName: "ground_message_reads_message_id_fkey"
            columns: ["message_id"]
            isOneToOne: false
            referencedRelation: "ground_messages"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ground_message_reads_crew_member_id_fkey"
            columns: ["crew_member_id"]
            isOneToOne: false
            referencedRelation: "crew_members"
            referencedColumns: ["id"]
          },
        ]
      }
      ambient_acoustics: {
        Row: {
          id: string
          module_id: string
          sensor_id: string
          window_start: string
          window_seconds: number
          laeq_dba: number
          lmax_dba: number | null
          peak_dbc: number | null
          octave_bands_db: number[] | null
          limit_exceeded: boolean
          created_at: string
        } & SyncRow
        Insert: {
          id?: string
          module_id: string
          sensor_id: string
          window_start: string
          window_seconds: number
          laeq_dba: number
          lmax_dba?: number | null
          peak_dbc?: number | null
          octave_bands_db?: number[] | null
          limit_exceeded?: boolean
          created_at?: string
        } & SyncInsert
        Update: {
          id?: string
          module_id?: string
          sensor_id?: string
          window_start?: string
          window_seconds?: number
          laeq_dba?: number
          lmax_dba?: number | null
          peak_dbc?: number | null
          octave_bands_db?: number[] | null
          limit_exceeded?: boolean
          created_at?: string
        } & SyncInsert
        Relationships: []
      }
      uplink_queue: {
        Row: {
          id: number
          source_table: ReplicatedTable
          source_id: string
          operation: Database["public"]["Enums"]["uplink_operation"]
          row_version: number
          payload: Json
          payload_bytes: number
          priority: number
          attempt_count: number
          next_attempt_at: string
          last_attempt_at: string | null
          last_error: string | null
          batch_id: string | null
          enqueued_at: string
          sync_status: Exclude<Database["public"]["Enums"]["sync_status"], "local_only">
          last_modified_at: string
          synced_at: string | null
        }
        // Rows are only created by omni_private.enqueue_change().
        Insert: never
        Update: {
          attempt_count?: number
          next_attempt_at?: string
          last_attempt_at?: string | null
          last_error?: string | null
          batch_id?: string | null
          sync_status?: Exclude<Database["public"]["Enums"]["sync_status"], "local_only">
          synced_at?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      use_medical_item: {
        Args: { p_item: string; p_count?: number }
        Returns: number | null
      }
      // Ground demo database only (scripts/demo-live-vitals.sql), never aboard.
      demo_solar_drill: {
        Args: Record<PropertyKey, never>
        Returns: string
      }
      get_link_status: {
        Args: Record<PropertyKey, never>
        Returns: {
          status: Database["public"]["Enums"]["uplink_link_status"]
          last_contact_at: string | null
          last_probe_at: string | null
          last_batch_at: string | null
          rtt_ms: number | null
          consecutive_failures: number
        }[]
      }
      get_uplink_backlog: {
        Args: Record<PropertyKey, never>
        Returns: {
          sync_status: Database["public"]["Enums"]["sync_status"]
          entries: number
          payload_bytes: number
          oldest_enqueued_at: string
        }[]
      }
    }
    Enums: {
      exercise_kind: "treadmill" | "resistance" | "cycle"
      message_priority: "routine" | "urgent"
      sync_status: "local_only" | "queued_for_earth" | "in_flight" | "synced" | "conflict"
      crew_role: "crew" | "flight_surgeon" | "commander" | "sensor_gateway"
      node_origin: "spacecraft" | "earth"
      telemetry_metric:
        | "heart_rate"
        | "heart_rate_variability"
        | "spo2"
        | "respiratory_rate"
        | "core_body_temp"
        | "skin_temp"
        | "bp_systolic"
        | "bp_diastolic"
        | "radiation_dose_rate"
        | "cumulative_radiation_dose"
        | "activity_level"
      alert_severity: "advisory" | "caution" | "warning" | "emergency"
      alert_status: "active" | "acknowledged" | "overridden" | "resolved"
      uplink_operation: "upsert" | "tombstone"
      uplink_link_status: "local_mode" | "uplink_active" | "degraded"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

export type ReplicatedTable = "crew_members" | "crew_telemetry" | "health_alerts" | "ambient_acoustics"

type PublicSchema = Database["public"]

export type Tables<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Row"]
export type TablesInsert<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Insert"]
export type TablesUpdate<T extends keyof PublicSchema["Tables"]> = PublicSchema["Tables"][T]["Update"]
export type Enums<T extends keyof PublicSchema["Enums"]> = PublicSchema["Enums"][T]

export const Constants = {
  public: {
    Enums: {
      exercise_kind: ["treadmill", "resistance", "cycle"],
      message_priority: ["routine", "urgent"],
      sync_status: ["local_only", "queued_for_earth", "in_flight", "synced", "conflict"],
      crew_role: ["crew", "flight_surgeon", "commander", "sensor_gateway"],
      node_origin: ["spacecraft", "earth"],
      telemetry_metric: [
        "heart_rate",
        "heart_rate_variability",
        "spo2",
        "respiratory_rate",
        "core_body_temp",
        "skin_temp",
        "bp_systolic",
        "bp_diastolic",
        "radiation_dose_rate",
        "cumulative_radiation_dose",
        "activity_level",
      ],
      alert_severity: ["advisory", "caution", "warning", "emergency"],
      alert_status: ["active", "acknowledged", "overridden", "resolved"],
      uplink_operation: ["upsert", "tombstone"],
      uplink_link_status: ["local_mode", "uplink_active", "degraded"],
    },
  },
} as const satisfies {
  public: { Enums: { [K in keyof PublicSchema["Enums"]]: readonly PublicSchema["Enums"][K][] } }
}
