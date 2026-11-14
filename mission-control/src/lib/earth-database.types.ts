// Mirrors mission-control/supabase/migrations/20261115000200_earth_uplink_ingest.sql.
// Regenerate with: supabase gen types typescript --project-id lsmseehtmkypftoumgrp --schema public

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  public: {
    Tables: {
      uplink_batches: {
        Row: {
          batch_id: string
          spacecraft_id: string
          envelope_created_at: string
          entry_count: number
          compressed_bytes: number
          received_at: string
          completed_at: string | null
          results: Json | null
        }
        Insert: {
          batch_id: string
          spacecraft_id: string
          envelope_created_at: string
          entry_count: number
          compressed_bytes: number
          received_at?: string
          completed_at?: string | null
          results?: Json | null
        }
        Update: {
          batch_id?: string
          spacecraft_id?: string
          envelope_created_at?: string
          entry_count?: number
          compressed_bytes?: number
          received_at?: string
          completed_at?: string | null
          results?: Json | null
        }
        Relationships: []
      }
      spacecraft_records: {
        Row: {
          spacecraft_id: string
          source_table: string
          source_id: string
          row_version: number
          operation: string
          payload: Json
          payload_sha256: string
          first_received_at: string
          last_received_at: string
          last_batch_id: string
        }
        Insert: {
          spacecraft_id: string
          source_table: string
          source_id: string
          row_version: number
          operation: string
          payload: Json
          payload_sha256: string
          first_received_at?: string
          last_received_at?: string
          last_batch_id: string
        }
        Update: {
          spacecraft_id?: string
          source_table?: string
          source_id?: string
          row_version?: number
          operation?: string
          payload?: Json
          payload_sha256?: string
          first_received_at?: string
          last_received_at?: string
          last_batch_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "spacecraft_records_last_batch_id_fkey"
            columns: ["last_batch_id"]
            isOneToOne: false
            referencedRelation: "uplink_batches"
            referencedColumns: ["batch_id"]
          },
        ]
      }
      spacecraft_record_conflicts: {
        Row: {
          id: number
          spacecraft_id: string
          source_table: string
          source_id: string
          row_version: number
          incoming_payload: Json
          stored_sha256: string
          batch_id: string
          detected_at: string
        }
        Insert: never
        Update: never
        Relationships: [
          {
            foreignKeyName: "spacecraft_record_conflicts_batch_id_fkey"
            columns: ["batch_id"]
            isOneToOne: false
            referencedRelation: "uplink_batches"
            referencedColumns: ["batch_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ingest_uplink_batch: {
        Args: { p_spacecraft_id: string; p_envelope: Json; p_compressed_bytes: number }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}
