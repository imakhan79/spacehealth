-- =============================================================================
-- OMNI — Earth central database: uplink ingest (Mission Control)
--
-- Receives batches relayed from one or more spacecraft. Everything is keyed by
-- spacecraft_id so multiple vehicles can share this database.
--
-- Merge rule per entry, against what Earth already holds for that row:
--   none stored                  -> store            accepted
--   incoming row_version newer   -> replace          accepted
--   same version, same content   -> no-op            accepted (duplicate)
--   same version, other content  -> keep, log       conflict (integrity)
--   incoming older               -> keep newer       accepted (superseded)
-- Only data errors reject an entry; transient database errors fail the whole
-- call so the spacecraft retries instead of losing data.
-- =============================================================================

create table public.uplink_batches (
  batch_id            uuid primary key,
  spacecraft_id       text not null check (char_length(spacecraft_id) between 1 and 64),
  envelope_created_at timestamptz not null,
  entry_count         integer not null check (entry_count > 0),
  compressed_bytes    integer not null check (compressed_bytes > 0),
  received_at         timestamptz not null default clock_timestamp(),
  completed_at        timestamptz,
  results             jsonb
);
create index uplink_batches_spacecraft_received_idx on public.uplink_batches (spacecraft_id, received_at desc);

create table public.spacecraft_records (
  spacecraft_id     text not null,
  source_table      text not null
                      check (source_table in ('crew_members', 'crew_telemetry', 'health_alerts', 'ambient_acoustics')),
  source_id         uuid not null,
  row_version       bigint not null check (row_version >= 1),
  operation         text not null check (operation in ('upsert', 'tombstone')),
  payload           jsonb not null,
  payload_sha256    text not null,
  first_received_at timestamptz not null default clock_timestamp(),
  last_received_at  timestamptz not null default clock_timestamp(),
  last_batch_id     uuid not null references public.uplink_batches (batch_id),
  primary key (spacecraft_id, source_table, source_id)
);
create index spacecraft_records_table_received_idx
  on public.spacecraft_records (spacecraft_id, source_table, last_received_at desc);
create index spacecraft_records_last_batch_idx on public.spacecraft_records (last_batch_id);

create table public.spacecraft_record_conflicts (
  id               bigint generated always as identity primary key,
  spacecraft_id    text not null,
  source_table     text not null,
  source_id        uuid not null,
  row_version      bigint not null,
  incoming_payload jsonb not null,
  stored_sha256    text not null,
  batch_id         uuid not null references public.uplink_batches (batch_id),
  detected_at      timestamptz not null default clock_timestamp()
);
create index spacecraft_record_conflicts_batch_idx on public.spacecraft_record_conflicts (batch_id);
create index spacecraft_record_conflicts_row_idx
  on public.spacecraft_record_conflicts (spacecraft_id, source_table, source_id);

-- Server-side only: no policies means anon/authenticated see nothing.
alter table public.uplink_batches enable row level security;
alter table public.spacecraft_records enable row level security;
alter table public.spacecraft_record_conflicts enable row level security;
revoke all on public.uplink_batches, public.spacecraft_records, public.spacecraft_record_conflicts
  from anon, authenticated;

create or replace function public.ingest_uplink_batch(
  p_spacecraft_id    text,
  p_envelope         jsonb,
  p_compressed_bytes integer
)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_batch_id   uuid;
  v_existing   public.uplink_batches;
  v_entry      jsonb;
  v_results    jsonb := '[]'::jsonb;
  v_status     text;
  v_reason     text;
  v_hash       text;
  v_version    bigint;
  v_stored     public.spacecraft_records;
begin
  if p_envelope ->> 'spacecraft_id' is distinct from p_spacecraft_id then
    raise exception 'envelope spacecraft_id does not match authenticated sender' using errcode = '42501';
  end if;
  v_batch_id := (p_envelope ->> 'batch_id')::uuid;

  -- Claim the batch id first. A concurrent delivery of the same batch blocks
  -- here until the first commits, then takes the duplicate path below.
  insert into public.uplink_batches (batch_id, spacecraft_id, envelope_created_at, entry_count, compressed_bytes)
  values (
    v_batch_id,
    p_spacecraft_id,
    (p_envelope ->> 'created_at')::timestamptz,
    jsonb_array_length(p_envelope -> 'entries'),
    p_compressed_bytes
  )
  on conflict (batch_id) do nothing;

  if not found then
    select * into v_existing from public.uplink_batches b where b.batch_id = v_batch_id;
    if v_existing.spacecraft_id <> p_spacecraft_id then
      raise exception 'batch id belongs to another spacecraft' using errcode = '42501';
    end if;
    return jsonb_build_object('batch_id', v_batch_id, 'duplicate', true, 'results', coalesce(v_existing.results, '[]'::jsonb));
  end if;

  for v_entry in select * from jsonb_array_elements(p_envelope -> 'entries')
  loop
    v_reason := null;
    begin
      v_version := (v_entry ->> 'row_version')::bigint;
      v_hash := encode(sha256(convert_to((v_entry -> 'payload')::text, 'UTF8')), 'hex');

      select * into v_stored
      from public.spacecraft_records r
      where r.spacecraft_id = p_spacecraft_id
        and r.source_table = v_entry ->> 'source_table'
        and r.source_id = (v_entry ->> 'source_id')::uuid
      for update;

      if not found then
        insert into public.spacecraft_records
          (spacecraft_id, source_table, source_id, row_version, operation, payload, payload_sha256, last_batch_id)
        values
          (p_spacecraft_id, v_entry ->> 'source_table', (v_entry ->> 'source_id')::uuid, v_version,
           v_entry ->> 'operation', v_entry -> 'payload', v_hash, v_batch_id);
        v_status := 'accepted';
      elsif v_version > v_stored.row_version then
        update public.spacecraft_records r
           set row_version = v_version,
               operation = v_entry ->> 'operation',
               payload = v_entry -> 'payload',
               payload_sha256 = v_hash,
               last_received_at = clock_timestamp(),
               last_batch_id = v_batch_id
         where r.spacecraft_id = v_stored.spacecraft_id
           and r.source_table = v_stored.source_table
           and r.source_id = v_stored.source_id;
        v_status := 'accepted';
      elsif v_version = v_stored.row_version and v_hash = v_stored.payload_sha256 then
        v_status := 'accepted';
        v_reason := 'duplicate';
      elsif v_version = v_stored.row_version then
        insert into public.spacecraft_record_conflicts
          (spacecraft_id, source_table, source_id, row_version, incoming_payload, stored_sha256, batch_id)
        values
          (p_spacecraft_id, v_stored.source_table, v_stored.source_id, v_version, v_entry -> 'payload',
           v_stored.payload_sha256, v_batch_id);
        v_status := 'conflict';
        v_reason := 'same row_version with different content already on Earth';
      else
        v_status := 'accepted';
        v_reason := 'superseded by newer version on Earth';
      end if;
    exception
      -- Bad data in this one entry: reject it, keep the rest of the batch.
      -- Anything else (locks, connections, ...) propagates and the spacecraft retries.
      when data_exception or integrity_constraint_violation then
        v_status := 'rejected';
        v_reason := left(sqlerrm, 500);
    end;

    v_results := v_results || jsonb_build_array(
      jsonb_build_object('queue_id', (v_entry ->> 'queue_id')::bigint, 'status', v_status)
      || case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason', v_reason) end
    );
  end loop;

  update public.uplink_batches b
     set results = v_results, completed_at = clock_timestamp()
   where b.batch_id = v_batch_id;

  return jsonb_build_object('batch_id', v_batch_id, 'duplicate', false, 'results', v_results);
end;
$$;

revoke all on function public.ingest_uplink_batch(text, jsonb, integer) from public, anon, authenticated;
grant execute on function public.ingest_uplink_batch(text, jsonb, integer) to service_role;
