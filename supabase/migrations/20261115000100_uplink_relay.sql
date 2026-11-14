-- =============================================================================
-- OMNI — Phase 3: uplink relay primitives (spacecraft side)
--
-- The relay worker (role omni_relay) drives the queue only through these
-- functions, so every state transition is atomic and enforced in one place:
--
--   relay_claim_batch     queued_for_earth -> in_flight     (one batch_id)
--   relay_ack_batch       in_flight -> synced | conflict    (Earth's verdict)
--   relay_release_batch   in_flight -> queued_for_earth     (send failed; backoff)
--   relay_in_flight_batches                                  (crash recovery)
--   relay_purge_synced                                       (disk hygiene)
--
-- Invariants:
--   * A source row is only marked synced/conflict if its row_version still
--     equals the version that was sent. A newer local edit always wins.
--   * Transport failures never drop or dead-letter data: entries go back to
--     the queue with exponential backoff (full jitter), however long the
--     blackout lasts. Only an explicit Earth verdict ends an entry's life.
-- =============================================================================

create type public.uplink_link_status as enum (
  'local_mode',     -- no Earth contact; everything is captured locally
  'uplink_active',  -- Earth reachable, batches flowing
  'degraded'        -- Earth reachable but rejecting/erroring; data retained
);

-- Single-row link state, written by the relay, read by the dashboard.
create table omni_private.uplink_link_state (
  id                   smallint primary key default 1 check (id = 1),
  status               public.uplink_link_status not null default 'local_mode',
  last_probe_at        timestamptz,
  last_contact_at      timestamptz,
  last_batch_at        timestamptz,
  rtt_ms               integer check (rtt_ms is null or rtt_ms >= 0),
  consecutive_failures integer not null default 0 check (consecutive_failures >= 0),
  last_error           text,
  updated_at           timestamptz not null default clock_timestamp()
);
insert into omni_private.uplink_link_state (id) values (1);

-- -----------------------------------------------------------------------------
-- Claim: pick the most urgent due entries up to a row and byte budget.
-- -----------------------------------------------------------------------------
create or replace function omni_private.relay_claim_batch(
  p_batch_id    uuid,
  p_max_entries integer,
  p_max_bytes   bigint
)
returns setof public.uplink_queue
language plpgsql
set search_path = ''
as $$
declare
  r       public.uplink_queue;
  v_bytes bigint := 0;
  v_count integer := 0;
begin
  if p_max_entries < 1 or p_max_bytes < 1 then
    raise exception 'relay_claim_batch: budgets must be positive' using errcode = '22023';
  end if;

  for r in
    select *
    from public.uplink_queue q
    where q.sync_status = 'queued_for_earth'
      and q.next_attempt_at <= clock_timestamp()
    order by q.priority, q.next_attempt_at, q.id
    limit p_max_entries
    for update skip locked
  loop
    -- Always take at least one entry so an oversized row can't wedge the queue.
    exit when v_count > 0 and v_bytes + r.payload_bytes > p_max_bytes;

    update public.uplink_queue q
       set sync_status     = 'in_flight',
           batch_id        = p_batch_id,
           attempt_count   = q.attempt_count + 1,
           last_attempt_at = clock_timestamp()
     where q.id = r.id
    returning * into r;

    execute format(
      'update public.%I t set sync_status = ''in_flight''
        where t.id = $1 and t.row_version = $2 and t.sync_status = ''queued_for_earth''',
      r.source_table)
      using r.source_id, r.row_version;

    v_bytes := v_bytes + r.payload_bytes;
    v_count := v_count + 1;
    return next r;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Release: the batch did not get a verdict. Back to the queue with backoff.
-- p_penalise = false for "Earth never saw it" cases (no backoff growth).
-- -----------------------------------------------------------------------------
create or replace function omni_private.relay_release_batch(
  p_batch_id  uuid,
  p_error     text,
  p_base_ms   integer default 5000,
  p_cap_ms    integer default 1800000,
  p_penalise  boolean default true
)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  r          public.uplink_queue;
  v_released integer := 0;
  v_delay_ms double precision;
begin
  for r in
    select * from public.uplink_queue q
    where q.batch_id = p_batch_id and q.sync_status = 'in_flight'
    for update
  loop
    -- A newer edit of the same row was queued while this one was in flight:
    -- its snapshot supersedes ours, so ours is simply dropped.
    if exists (
      select 1 from public.uplink_queue n
      where n.source_table = r.source_table
        and n.source_id = r.source_id
        and n.sync_status = 'queued_for_earth'
    ) then
      delete from public.uplink_queue where id = r.id;
    else
      if p_penalise then
        -- Full jitter: uniform in [0, min(cap, base * 2^(attempt-1))].
        v_delay_ms := random() * least(p_cap_ms::double precision,
                                       p_base_ms * power(2, greatest(r.attempt_count - 1, 0)));
      else
        v_delay_ms := 0;
      end if;

      update public.uplink_queue q
         set sync_status     = 'queued_for_earth',
             batch_id        = null,
             last_error      = left(p_error, 1000),
             attempt_count   = case when p_penalise then q.attempt_count else greatest(q.attempt_count - 1, 0) end,
             next_attempt_at = clock_timestamp() + make_interval(secs => v_delay_ms / 1000.0)
       where q.id = r.id;
    end if;

    execute format(
      'update public.%I t set sync_status = ''queued_for_earth''
        where t.id = $1 and t.row_version = $2 and t.sync_status = ''in_flight''',
      r.source_table)
      using r.source_id, r.row_version;

    v_released := v_released + 1;
  end loop;

  return v_released;
end;
$$;

-- -----------------------------------------------------------------------------
-- Ack: apply Earth's per-entry verdicts. Entries Earth did not mention are
-- released without penalty so nothing is ever silently stranded in flight.
--   p_results: [{"queue_id": 12, "status": "accepted"|"conflict"|"rejected", "reason": "..."}]
-- -----------------------------------------------------------------------------
create or replace function omni_private.relay_ack_batch(p_batch_id uuid, p_results jsonb)
returns table (accepted integer, conflicted integer, released integer)
language plpgsql
set search_path = ''
as $$
declare
  v_item     jsonb;
  v_status   text;
  r          public.uplink_queue;
  v_accepted integer := 0;
  v_conflict integer := 0;
begin
  if jsonb_typeof(p_results) is distinct from 'array' then
    raise exception 'relay_ack_batch: results must be a JSON array' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(p_results)
  loop
    v_status := v_item ->> 'status';
    if v_status not in ('accepted', 'conflict', 'rejected') then
      raise exception 'relay_ack_batch: unknown status %', v_status using errcode = '22023';
    end if;

    update public.uplink_queue q
       set sync_status = case when v_status = 'accepted' then 'synced' else 'conflict' end::public.sync_status,
           synced_at   = case when v_status = 'accepted' then clock_timestamp() end,
           last_error  = case when v_status = 'accepted' then null
                              else left(v_status || ': ' || coalesce(v_item ->> 'reason', 'no reason given'), 1000) end
     where q.id = (v_item ->> 'queue_id')::bigint
       and q.batch_id = p_batch_id
       and q.sync_status = 'in_flight'
    returning * into r;

    continue when not found;  -- duplicate/late ACK: already settled

    if v_status = 'accepted' then
      v_accepted := v_accepted + 1;
      execute format(
        'update public.%I t
            set earth_ack_version = greatest(t.earth_ack_version, $2),
                synced_at = clock_timestamp(),
                sync_status = case when t.row_version = $2 and t.sync_status = ''in_flight''
                                   then ''synced''::public.sync_status else t.sync_status end
          where t.id = $1',
        r.source_table)
        using r.source_id, r.row_version;
    else
      v_conflict := v_conflict + 1;
      execute format(
        'update public.%I t set sync_status = ''conflict''
          where t.id = $1 and t.row_version = $2 and t.sync_status = ''in_flight''',
        r.source_table)
        using r.source_id, r.row_version;
    end if;
  end loop;

  return query
    select v_accepted, v_conflict,
           omni_private.relay_release_batch(p_batch_id, 'no verdict from Earth for this entry', p_penalise => false);
end;
$$;

-- Batches left in flight (e.g. relay restarted mid-send, or a 202 receipt is
-- still pending). The relay asks Earth for their receipts.
create or replace function omni_private.relay_in_flight_batches()
returns table (batch_id uuid, entries bigint, oldest_attempt_at timestamptz)
language sql
stable
set search_path = ''
as $$
  select q.batch_id, count(*), min(q.last_attempt_at)
  from public.uplink_queue q
  where q.sync_status = 'in_flight'
  group by q.batch_id
  order by min(q.last_attempt_at);
$$;

-- Synced queue entries are an audit trail, not data (the source rows hold the
-- data). Keep them for a while, then free the disk.
create or replace function omni_private.relay_purge_synced(p_older_than interval default interval '7 days')
returns integer
language sql
set search_path = ''
as $$
  with gone as (
    delete from public.uplink_queue q
    where q.sync_status = 'synced' and q.synced_at < clock_timestamp() - p_older_than
    returning 1
  )
  select count(*)::integer from gone;
$$;

create or replace function omni_private.relay_record_link(
  p_status     public.uplink_link_status,
  p_rtt_ms     integer,
  p_error      text,
  p_contact    boolean,
  p_batch_sent boolean default false
)
returns void
language sql
set search_path = ''
as $$
  update omni_private.uplink_link_state s
     set status               = p_status,
         last_probe_at        = clock_timestamp(),
         last_contact_at      = case when p_contact then clock_timestamp() else s.last_contact_at end,
         last_batch_at        = case when p_batch_sent then clock_timestamp() else s.last_batch_at end,
         rtt_ms               = coalesce(p_rtt_ms, s.rtt_ms),
         consecutive_failures = case when p_status = 'uplink_active' then 0 else s.consecutive_failures + 1 end,
         last_error           = case when p_status = 'uplink_active' then null else left(p_error, 500) end,
         updated_at           = clock_timestamp()
   where s.id = 1;
$$;

-- Dashboard read model (Phase 4 "Local Mode / Earth Uplink Active" indicator).
create or replace function public.get_link_status()
returns table (
  status               public.uplink_link_status,
  last_contact_at      timestamptz,
  last_probe_at        timestamptz,
  last_batch_at        timestamptz,
  rtt_ms               integer,
  consecutive_failures integer
)
language sql
stable
security definer
set search_path = ''
as $$
  select s.status, s.last_contact_at, s.last_probe_at, s.last_batch_at, s.rtt_ms, s.consecutive_failures
  from omni_private.uplink_link_state s
  where omni_private.current_crew_role() is not null;
$$;

-- -----------------------------------------------------------------------------
-- Privileges
-- -----------------------------------------------------------------------------
revoke all on omni_private.uplink_link_state from public;
grant select, update on omni_private.uplink_link_state to omni_relay;

revoke all on function omni_private.relay_claim_batch(uuid, integer, bigint),
                       omni_private.relay_release_batch(uuid, text, integer, integer, boolean),
                       omni_private.relay_ack_batch(uuid, jsonb),
                       omni_private.relay_in_flight_batches(),
                       omni_private.relay_purge_synced(interval),
                       omni_private.relay_record_link(public.uplink_link_status, integer, text, boolean, boolean)
  from public;
grant execute on function omni_private.relay_claim_batch(uuid, integer, bigint),
                          omni_private.relay_release_batch(uuid, text, integer, integer, boolean),
                          omni_private.relay_ack_batch(uuid, jsonb),
                          omni_private.relay_in_flight_batches(),
                          omni_private.relay_purge_synced(interval),
                          omni_private.relay_record_link(public.uplink_link_status, integer, text, boolean, boolean)
  to omni_relay;

revoke all on function public.get_link_status() from public, anon;
grant execute on function public.get_link_status() to authenticated;
