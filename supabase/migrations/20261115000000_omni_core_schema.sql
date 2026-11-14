-- =============================================================================
-- OMNI — Phase 1: Spacecraft-local core schema
--
-- Runs on the self-hosted Supabase Postgres aboard the spacecraft.
--
-- Sync model (spacecraft -> Earth):
--   * Every replicated table carries the same sync bookkeeping columns:
--       sync_status        local_only -> queued_for_earth -> in_flight -> synced | conflict
--       last_modified_at   DB-assigned, strictly monotonic per row (survives clock steps)
--       row_version        +1 on every content change; the merge key Earth compares
--       earth_ack_version  highest row_version Earth has confirmed
--       origin_node        where the current content was authored
--       hold_onboard       crew/medical privacy hold: row stays local_only
--       deleted_at         tombstone; medical records are never hard-deleted
--   * Clients can never write sync bookkeeping. Triggers own it.
--   * Any content change by a non-relay session is snapshotted into uplink_queue.
--     Multiple pending changes to the same row coalesce into one queue entry.
--   * Only the relay (role omni_relay) may move rows to
--     in_flight / synced / conflict, and its writes never re-enqueue.
--     The relay MUST mark rows synced with `WHERE row_version = <sent version>`
--     so a local edit made while a batch was in flight is never lost.
-- =============================================================================

create schema if not exists omni_private;
revoke all on schema omni_private from public;

-- -----------------------------------------------------------------------------
-- Roles
-- -----------------------------------------------------------------------------
-- Relay worker identity (Phase 3). Created NOLOGIN here; Phase 2 grants LOGIN
-- with a password from the spacecraft's local secret store.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'omni_relay') then
    create role omni_relay nologin noinherit;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- Enums
-- -----------------------------------------------------------------------------
create type public.sync_status as enum (
  'local_only',        -- exists only aboard; not scheduled for uplink (or on hold)
  'queued_for_earth',  -- change captured in uplink_queue, waiting for DSN window
  'in_flight',         -- part of a transmitted batch, awaiting Earth ACK
  'synced',            -- Earth acknowledged this row_version
  'conflict'           -- Earth rejected: it holds a divergent version
);

create type public.crew_role as enum (
  'crew',
  'flight_surgeon',    -- onboard crew medical officer
  'commander',
  'sensor_gateway'     -- machine identity for the biomedical/acoustic sensor bus
);

create type public.node_origin as enum ('spacecraft', 'earth');

create type public.telemetry_metric as enum (
  'heart_rate',
  'heart_rate_variability',
  'spo2',
  'respiratory_rate',
  'core_body_temp',
  'skin_temp',
  'bp_systolic',
  'bp_diastolic',
  'radiation_dose_rate',
  'cumulative_radiation_dose',
  'activity_level'
);

-- Caution & Warning classes, lowest to highest.
create type public.alert_severity as enum ('advisory', 'caution', 'warning', 'emergency');

create type public.alert_status as enum ('active', 'acknowledged', 'overridden', 'resolved');

create type public.uplink_operation as enum ('upsert', 'tombstone');

-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

-- Crew roster, bound 1:1 to local GoTrue users. Required for RLS decisions.
create table public.crew_members (
  id                uuid primary key default gen_random_uuid(),
  auth_user_id      uuid not null unique references auth.users (id) on delete restrict,
  callsign          text not null unique check (char_length(callsign) between 1 and 32),
  full_name         text not null check (char_length(full_name) between 1 and 200),
  role              public.crew_role not null default 'crew',
  is_active         boolean not null default true,
  created_at        timestamptz not null default clock_timestamp(),
  -- sync bookkeeping
  hold_onboard      boolean not null default false,
  deleted_at        timestamptz,
  sync_status       public.sync_status not null default 'local_only',
  last_modified_at  timestamptz not null default clock_timestamp(),
  row_version       bigint not null default 1 check (row_version >= 1),
  earth_ack_version bigint not null default 0 check (earth_ack_version >= 0),
  origin_node       public.node_origin not null default 'spacecraft',
  synced_at         timestamptz
);

-- Biomedical samples. Immutable once written (corrections are new samples).
-- The sensor gateway should insert epoch aggregates (e.g. 1-minute), not raw
-- waveforms, to keep the uplink budget sane.
create table public.crew_telemetry (
  id                uuid primary key default gen_random_uuid(),
  crew_member_id    uuid not null references public.crew_members (id) on delete restrict,
  metric            public.telemetry_metric not null,
  value             double precision not null
                      check (value not in ('NaN'::float8, 'Infinity'::float8, '-Infinity'::float8)),
  unit              text not null check (char_length(unit) between 1 and 16),
  recorded_at       timestamptz not null,
  device_id         text not null check (char_length(device_id) between 1 and 64),
  signal_quality    smallint check (signal_quality between 0 and 100),
  created_at        timestamptz not null default clock_timestamp(),
  -- sync bookkeeping
  hold_onboard      boolean not null default false,
  deleted_at        timestamptz,
  sync_status       public.sync_status not null default 'local_only',
  last_modified_at  timestamptz not null default clock_timestamp(),
  row_version       bigint not null default 1 check (row_version >= 1),
  earth_ack_version bigint not null default 0 check (earth_ack_version >= 0),
  origin_node       public.node_origin not null default 'spacecraft',
  synced_at         timestamptz,
  -- Idempotent ingest: a sensor retrying the same sample cannot duplicate it.
  constraint crew_telemetry_sample_unique unique (crew_member_id, metric, device_id, recorded_at)
);

-- Automated health alerts and their human disposition (ack / override).
-- Phase 4's "astronaut overrides an alert" mutation lands here.
create table public.health_alerts (
  id                uuid primary key default gen_random_uuid(),
  crew_member_id    uuid not null references public.crew_members (id) on delete restrict,
  telemetry_id      uuid references public.crew_telemetry (id) on delete restrict,
  metric            public.telemetry_metric,
  severity          public.alert_severity not null,
  status            public.alert_status not null default 'active',
  message           text not null check (char_length(message) between 1 and 500),
  triggered_at      timestamptz not null default clock_timestamp(),
  acknowledged_by   uuid references public.crew_members (id) on delete restrict,
  acknowledged_at   timestamptz,
  overridden_by     uuid references public.crew_members (id) on delete restrict,
  overridden_at     timestamptz,
  override_reason   text check (override_reason is null or char_length(override_reason) between 3 and 1000),
  resolved_at       timestamptz,
  created_at        timestamptz not null default clock_timestamp(),
  -- sync bookkeeping
  hold_onboard      boolean not null default false,
  deleted_at        timestamptz,
  sync_status       public.sync_status not null default 'local_only',
  last_modified_at  timestamptz not null default clock_timestamp(),
  row_version       bigint not null default 1 check (row_version >= 1),
  earth_ack_version bigint not null default 0 check (earth_ack_version >= 0),
  origin_node       public.node_origin not null default 'spacecraft',
  synced_at         timestamptz,
  constraint health_alerts_ack_complete check (
    status <> 'acknowledged' or (acknowledged_by is not null and acknowledged_at is not null)
  ),
  constraint health_alerts_override_complete check (
    status <> 'overridden'
    or (overridden_by is not null and overridden_at is not null and override_reason is not null)
  ),
  constraint health_alerts_resolved_complete check (status <> 'resolved' or resolved_at is not null)
);

-- Cabin noise exposure per sensor window.
create table public.ambient_acoustics (
  id                uuid primary key default gen_random_uuid(),
  module_id         text not null check (char_length(module_id) between 1 and 64),
  sensor_id         text not null check (char_length(sensor_id) between 1 and 64),
  window_start      timestamptz not null,
  window_seconds    integer not null check (window_seconds between 1 and 86400),
  laeq_dba          real not null check (laeq_dba between 0 and 194),
  lmax_dba          real check (lmax_dba between 0 and 194),
  peak_dbc          real check (peak_dbc between 0 and 194),
  -- 10 octave bands, 31.5 Hz .. 16 kHz
  octave_bands_db   real[] check (octave_bands_db is null or cardinality(octave_bands_db) = 10),
  limit_exceeded    boolean not null default false,
  created_at        timestamptz not null default clock_timestamp(),
  -- sync bookkeeping
  hold_onboard      boolean not null default false,
  deleted_at        timestamptz,
  sync_status       public.sync_status not null default 'local_only',
  last_modified_at  timestamptz not null default clock_timestamp(),
  row_version       bigint not null default 1 check (row_version >= 1),
  earth_ack_version bigint not null default 0 check (earth_ack_version >= 0),
  origin_node       public.node_origin not null default 'spacecraft',
  synced_at         timestamptz,
  constraint ambient_acoustics_lmax_ge_leq check (lmax_dba is null or lmax_dba >= laeq_dba),
  constraint ambient_acoustics_window_unique unique (sensor_id, window_start)
);

-- Outbound change log. One pending entry per source row (coalesced); entries
-- that are in_flight are frozen, so a new edit during transmission gets a new
-- entry instead of mutating what Earth is about to ACK.
create table public.uplink_queue (
  id                bigint generated always as identity primary key,
  source_table      text not null check (
                      source_table in ('crew_members', 'crew_telemetry', 'health_alerts', 'ambient_acoustics')
                    ),
  source_id         uuid not null,
  operation         public.uplink_operation not null,
  row_version       bigint not null check (row_version >= 1),
  payload           jsonb not null,
  payload_bytes     integer generated always as (octet_length(payload::text)) stored,
  priority          smallint not null default 5 check (priority between 0 and 9), -- 0 = most urgent
  attempt_count     integer not null default 0 check (attempt_count >= 0),
  next_attempt_at   timestamptz not null default clock_timestamp(),
  last_attempt_at   timestamptz,
  last_error        text,
  batch_id          uuid,
  enqueued_at       timestamptz not null default clock_timestamp(),
  -- sync bookkeeping (state of this queue entry)
  sync_status       public.sync_status not null default 'queued_for_earth'
                      check (sync_status <> 'local_only'),
  last_modified_at  timestamptz not null default clock_timestamp(),
  synced_at         timestamptz,
  constraint uplink_queue_in_flight_has_batch check (sync_status <> 'in_flight' or batch_id is not null)
);

-- -----------------------------------------------------------------------------
-- Indexes
-- -----------------------------------------------------------------------------
create index crew_telemetry_member_metric_time_idx on public.crew_telemetry (crew_member_id, metric, recorded_at desc);
create index crew_telemetry_unsynced_idx on public.crew_telemetry (sync_status) where sync_status <> 'synced';

create index health_alerts_open_idx on public.health_alerts (crew_member_id, triggered_at desc)
  where status in ('active', 'acknowledged');
create index health_alerts_triggered_idx on public.health_alerts (triggered_at desc);
create index health_alerts_telemetry_idx on public.health_alerts (telemetry_id);
create index health_alerts_acknowledged_by_idx on public.health_alerts (acknowledged_by);
create index health_alerts_overridden_by_idx on public.health_alerts (overridden_by);
create index health_alerts_unsynced_idx on public.health_alerts (sync_status) where sync_status <> 'synced';

create index ambient_acoustics_module_time_idx on public.ambient_acoustics (module_id, window_start desc);
create index ambient_acoustics_unsynced_idx on public.ambient_acoustics (sync_status) where sync_status <> 'synced';

create index crew_members_unsynced_idx on public.crew_members (sync_status) where sync_status <> 'synced';

-- Coalescing target: at most one pending entry per source row.
create unique index uplink_queue_pending_coalesce_idx on public.uplink_queue (source_table, source_id)
  where sync_status = 'queued_for_earth';
-- Dispatcher scan: most urgent first, then oldest.
create index uplink_queue_dispatch_idx on public.uplink_queue (priority, next_attempt_at, id)
  where sync_status = 'queued_for_earth';
create index uplink_queue_batch_idx on public.uplink_queue (batch_id) where batch_id is not null;

-- -----------------------------------------------------------------------------
-- Identity helpers (used by RLS). SECURITY DEFINER so policies on
-- crew_members do not recurse; search_path pinned to defeat hijacking.
-- -----------------------------------------------------------------------------
create or replace function omni_private.is_relay()
returns boolean
language sql
stable
set search_path = ''
as $$
  -- SECURITY INVOKER on purpose: current_user is the caller's effective role.
  -- Only the dedicated relay login counts. service_role (admin provisioning)
  -- writes are ordinary content changes and must still reach Earth.
  select current_user = 'omni_relay';
$$;

create or replace function omni_private.current_crew_member_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select cm.id
  from public.crew_members cm
  where cm.auth_user_id = auth.uid()
    and cm.is_active
    and cm.deleted_at is null;
$$;

create or replace function omni_private.current_crew_role()
returns public.crew_role
language sql
stable
security definer
set search_path = ''
as $$
  select cm.role
  from public.crew_members cm
  where cm.auth_user_id = auth.uid()
    and cm.is_active
    and cm.deleted_at is null;
$$;

create or replace function omni_private.has_medical_oversight()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(omni_private.current_crew_role() in ('flight_surgeon', 'commander'), false);
$$;

-- -----------------------------------------------------------------------------
-- Sync triggers
-- -----------------------------------------------------------------------------

-- BEFORE INSERT/UPDATE: owns every sync column for non-relay writers.
create or replace function omni_private.tg_sync_before_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if omni_private.is_relay() then
    -- The relay sets sync columns explicitly (ACKs, Earth downlinks).
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.row_version       := 1;
    new.earth_ack_version := 0;
    new.origin_node       := 'spacecraft';
    new.synced_at         := null;
    new.created_at        := clock_timestamp();
    new.last_modified_at  := clock_timestamp();
    new.sync_status       := case when new.hold_onboard then 'local_only' else 'queued_for_earth' end;
    return new;
  end if;

  -- UPDATE: discard any client attempt to touch bookkeeping.
  new.created_at        := old.created_at;
  new.row_version       := old.row_version;
  new.earth_ack_version := old.earth_ack_version;
  new.origin_node       := old.origin_node;
  new.synced_at         := old.synced_at;
  new.sync_status       := old.sync_status;
  new.last_modified_at  := old.last_modified_at;

  if to_jsonb(new) = to_jsonb(old) then
    return new; -- no-op update: do not bump version or re-queue
  end if;

  new.row_version      := old.row_version + 1;
  new.origin_node      := 'spacecraft';
  -- Monotonic even if the onboard clock is stepped backwards by a time sync.
  new.last_modified_at := greatest(clock_timestamp(), old.last_modified_at + interval '1 microsecond');
  new.sync_status      := case when new.hold_onboard then 'local_only' else 'queued_for_earth' end;
  return new;
end;
$$;

-- Snapshots the committed-to-be row into uplink_queue. SECURITY DEFINER so
-- clients need no privileges on uplink_queue; it re-reads the row itself and
-- only enqueues rows that are genuinely queued_for_earth, so it cannot be used
-- to inject arbitrary payloads.
create or replace function omni_private.enqueue_change(p_table text, p_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row      jsonb;
  v_priority smallint;
begin
  if p_table not in ('crew_members', 'crew_telemetry', 'health_alerts', 'ambient_acoustics') then
    raise exception 'enqueue_change: table % is not replicated', p_table using errcode = '22023';
  end if;

  execute format('select to_jsonb(t) from public.%I t where t.id = $1', p_table)
    into v_row
    using p_id;

  if v_row is null or v_row ->> 'sync_status' <> 'queued_for_earth' then
    return;
  end if;

  v_priority := case p_table
    when 'health_alerts' then
      case v_row ->> 'severity'
        when 'emergency' then 0
        when 'warning'   then 1
        when 'caution'   then 2
        else 3
      end
    when 'crew_members'   then 4
    when 'crew_telemetry' then 5
    else 7
  end;

  insert into public.uplink_queue (source_table, source_id, operation, row_version, payload, priority)
  values (
    p_table,
    p_id,
    case when v_row ->> 'deleted_at' is null then 'upsert' else 'tombstone' end::public.uplink_operation,
    (v_row ->> 'row_version')::bigint,
    v_row,
    v_priority
  )
  on conflict (source_table, source_id) where sync_status = 'queued_for_earth'
  do update set
    operation        = excluded.operation,
    row_version      = excluded.row_version,
    payload          = excluded.payload,
    priority         = least(public.uplink_queue.priority, excluded.priority),
    next_attempt_at  = least(public.uplink_queue.next_attempt_at, excluded.next_attempt_at),
    last_modified_at = clock_timestamp();
end;
$$;

-- AFTER INSERT/UPDATE: enqueue when content changed (version bumped).
create or replace function omni_private.tg_sync_after_write()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if omni_private.is_relay() or new.sync_status <> 'queued_for_earth' then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform omni_private.enqueue_change(tg_table_name, new.id);
  elsif new.row_version <> old.row_version then
    perform omni_private.enqueue_change(tg_table_name, new.id);
  end if;

  return null;
end;
$$;

create or replace function omni_private.tg_uplink_queue_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.last_modified_at := clock_timestamp();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Health alert disposition guard (runs before the sync trigger: name order)
-- -----------------------------------------------------------------------------
create or replace function omni_private.tg_health_alert_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_role public.crew_role;
  v_me   uuid;
begin
  if omni_private.is_relay() then
    return new;
  end if;

  if new.status = old.status then
    if new.override_reason is distinct from old.override_reason and new.status <> 'overridden' then
      raise exception 'override_reason can only be set while overriding an alert' using errcode = '22023';
    end if;
    return new;
  end if;

  v_role := omni_private.current_crew_role();
  v_me   := omni_private.current_crew_member_id();

  if v_role is null then
    raise exception 'No active crew identity for this session' using errcode = '42501';
  end if;

  if not (
       (old.status = 'active'       and new.status in ('acknowledged', 'overridden', 'resolved'))
    or (old.status = 'acknowledged' and new.status in ('overridden', 'resolved'))
    or (old.status = 'overridden'   and new.status in ('active', 'resolved'))
  ) then
    raise exception 'Illegal alert transition % -> %', old.status, new.status using errcode = '22023';
  end if;

  if new.status in ('acknowledged', 'overridden', 'active') and v_role = 'sensor_gateway' then
    raise exception 'Sensor gateway may only resolve alerts' using errcode = '42501';
  end if;

  -- Life-critical rule: only medical oversight can silence WARNING/EMERGENCY.
  if new.status = 'overridden'
     and old.severity in ('warning', 'emergency')
     and v_role not in ('flight_surgeon', 'commander') then
    raise exception 'Overriding a % alert requires flight_surgeon or commander', old.severity
      using errcode = '42501';
  end if;

  if new.status = 'resolved' and v_role not in ('flight_surgeon', 'commander', 'sensor_gateway') then
    raise exception 'Resolving an alert requires flight_surgeon, commander, or sensor_gateway'
      using errcode = '42501';
  end if;

  -- Server stamps who/when; clients cannot forge another crew member.
  case new.status
    when 'acknowledged' then
      new.acknowledged_by := v_me;
      new.acknowledged_at := clock_timestamp();
    when 'overridden' then
      if new.override_reason is null then
        raise exception 'override_reason is required' using errcode = '23502';
      end if;
      new.overridden_by := v_me;
      new.overridden_at := clock_timestamp();
    when 'resolved' then
      new.resolved_at := clock_timestamp();
    when 'active' then
      -- Re-arm a previously overridden alert.
      new.overridden_by   := null;
      new.overridden_at   := null;
      new.override_reason := null;
  end case;

  return new;
end;
$$;

-- Trigger names are prefixed so BEFORE triggers fire in a defined order.
create trigger t10_alert_guard
  before update on public.health_alerts
  for each row execute function omni_private.tg_health_alert_guard();

create trigger t20_sync_before before insert or update on public.crew_members
  for each row execute function omni_private.tg_sync_before_write();
create trigger t20_sync_before before insert or update on public.crew_telemetry
  for each row execute function omni_private.tg_sync_before_write();
create trigger t20_sync_before before insert or update on public.health_alerts
  for each row execute function omni_private.tg_sync_before_write();
create trigger t20_sync_before before insert or update on public.ambient_acoustics
  for each row execute function omni_private.tg_sync_before_write();

create trigger t90_sync_after after insert or update on public.crew_members
  for each row execute function omni_private.tg_sync_after_write();
create trigger t90_sync_after after insert or update on public.crew_telemetry
  for each row execute function omni_private.tg_sync_after_write();
create trigger t90_sync_after after insert or update on public.health_alerts
  for each row execute function omni_private.tg_sync_after_write();
create trigger t90_sync_after after insert or update on public.ambient_acoustics
  for each row execute function omni_private.tg_sync_after_write();

create trigger t20_touch before update on public.uplink_queue
  for each row execute function omni_private.tg_uplink_queue_touch();

-- -----------------------------------------------------------------------------
-- Dashboard read model for the uplink backlog (Phase 4 network indicator).
-- Crew never read uplink_queue directly.
-- -----------------------------------------------------------------------------
create or replace function public.get_uplink_backlog()
returns table (
  sync_status        public.sync_status,
  entries            bigint,
  payload_bytes      bigint,
  oldest_enqueued_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select q.sync_status,
         count(*)::bigint,
         coalesce(sum(q.payload_bytes), 0)::bigint,
         min(q.enqueued_at)
  from public.uplink_queue q
  where q.sync_status in ('queued_for_earth', 'in_flight', 'conflict')
    and omni_private.current_crew_role() is not null
  group by q.sync_status;
$$;

-- -----------------------------------------------------------------------------
-- Privileges. Supabase's default privileges grant ALL to anon/authenticated
-- on new public tables; strip that and grant back the minimum.
-- -----------------------------------------------------------------------------
revoke all on public.crew_members, public.crew_telemetry, public.health_alerts,
              public.ambient_acoustics, public.uplink_queue
  from anon, authenticated, public;

grant select on public.crew_members, public.crew_telemetry, public.health_alerts,
                public.ambient_acoustics
  to authenticated;
grant insert on public.crew_telemetry, public.health_alerts, public.ambient_acoustics to authenticated;
-- The only client-writable alert columns. Everything else is server-stamped.
grant update (status, override_reason) on public.health_alerts to authenticated;

grant usage on schema public to omni_relay;
grant select, insert, update on public.crew_members, public.crew_telemetry, public.health_alerts,
                                public.ambient_acoustics
  to omni_relay;
grant select, update, delete on public.uplink_queue to omni_relay;

revoke all on all functions in schema omni_private from public;
grant usage on schema omni_private to authenticated, omni_relay, service_role;
grant execute on function omni_private.is_relay(),
                          omni_private.current_crew_member_id(),
                          omni_private.current_crew_role(),
                          omni_private.has_medical_oversight()
  to authenticated, omni_relay, service_role;
-- Called from the (invoker) AFTER trigger. Safe to expose: it re-reads the row
-- and only enqueues what the BEFORE trigger already marked queued_for_earth.
-- omni_private is not in PostgREST's exposed schemas, so it is not an RPC.
grant execute on function omni_private.enqueue_change(text, uuid) to authenticated, service_role;

revoke all on function public.get_uplink_backlog() from public, anon;
grant execute on function public.get_uplink_backlog() to authenticated;

-- -----------------------------------------------------------------------------
-- Row Level Security. Deny by default; no DELETE policy for any crew role.
-- -----------------------------------------------------------------------------
alter table public.crew_members      enable row level security;
alter table public.crew_telemetry    enable row level security;
alter table public.health_alerts     enable row level security;
alter table public.ambient_acoustics enable row level security;
alter table public.uplink_queue      enable row level security;

-- crew_members -----------------------------------------------------------------
create policy crew_members_select_active_crew on public.crew_members
  for select to authenticated
  using ((select omni_private.current_crew_role()) is not null);

-- crew_telemetry: own vitals, or everyone's with medical oversight -------------
create policy crew_telemetry_select_own_or_oversight on public.crew_telemetry
  for select to authenticated
  using (
    crew_member_id = (select omni_private.current_crew_member_id())
    or (select omni_private.has_medical_oversight())
  );

create policy crew_telemetry_insert_sensor_gateway on public.crew_telemetry
  for insert to authenticated
  with check (
    (select omni_private.current_crew_role()) = 'sensor_gateway'
    and deleted_at is null
  );

-- health_alerts ----------------------------------------------------------------
create policy health_alerts_select_own_or_oversight on public.health_alerts
  for select to authenticated
  using (
    crew_member_id = (select omni_private.current_crew_member_id())
    or (select omni_private.has_medical_oversight())
  );

create policy health_alerts_insert_gateway_or_surgeon on public.health_alerts
  for insert to authenticated
  with check (
    (select omni_private.current_crew_role()) in ('sensor_gateway', 'flight_surgeon')
    and status = 'active'
    and deleted_at is null
  );

-- Column grants limit WHAT can change; tg_health_alert_guard limits HOW.
create policy health_alerts_update_subject_oversight_or_gateway on public.health_alerts
  for update to authenticated
  using (
    crew_member_id = (select omni_private.current_crew_member_id())
    or (select omni_private.has_medical_oversight())
    or (select omni_private.current_crew_role()) = 'sensor_gateway'
  )
  with check (
    crew_member_id = (select omni_private.current_crew_member_id())
    or (select omni_private.has_medical_oversight())
    or (select omni_private.current_crew_role()) = 'sensor_gateway'
  );

-- ambient_acoustics: cabin environment is visible to all crew ------------------
create policy ambient_acoustics_select_active_crew on public.ambient_acoustics
  for select to authenticated
  using ((select omni_private.current_crew_role()) is not null);

create policy ambient_acoustics_insert_sensor_gateway on public.ambient_acoustics
  for insert to authenticated
  with check (
    (select omni_private.current_crew_role()) = 'sensor_gateway'
    and deleted_at is null
  );

-- uplink_queue: no crew access at all (read via get_uplink_backlog) ------------

-- Relay worker -----------------------------------------------------------------
create policy crew_members_relay on public.crew_members
  for all to omni_relay using (true) with check (true);
create policy crew_telemetry_relay on public.crew_telemetry
  for all to omni_relay using (true) with check (true);
create policy health_alerts_relay on public.health_alerts
  for all to omni_relay using (true) with check (true);
create policy ambient_acoustics_relay on public.ambient_acoustics
  for all to omni_relay using (true) with check (true);
create policy uplink_queue_relay on public.uplink_queue
  for all to omni_relay using (true) with check (true);
