-- Verbatim from supabase/supabase docker/volumes/db/realtime.sql (master, fetched 2026-11-15)
\set pguser `echo "$POSTGRES_USER"`

create schema if not exists _realtime;
alter schema _realtime owner to :pguser;
