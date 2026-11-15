-- =============================================================================
-- OMNI ambient health monitoring: cabin air quality and medical procedure runs
--
--   cabin_air        per-module air readings (CO2, O2, humidity, temperature)
--                    written by the sensor gateway; every crew member can read.
--   procedure_runs   one guided medical procedure (protocol defined in the app)
--   procedure_steps  each completed step, stamped with who and when
--
-- In an emergency anyone aboard may run a procedure on anyone, so runs are
-- visible to and editable by every crew member; who did what is always
-- stamped server-side and can't be rewritten. Onboard-only (not replicated).
-- =============================================================================

create table public.cabin_air (
  id            uuid primary key default gen_random_uuid(),
  module_id     text not null check (char_length(module_id) between 1 and 64),
  sensor_id     text not null check (char_length(sensor_id) between 1 and 64),
  window_start  timestamptz not null,
  co2_ppm       real not null check (co2_ppm between 0 and 50000),
  o2_pct        real not null check (o2_pct between 0 and 100),
  humidity_pct  real not null check (humidity_pct between 0 and 100),
  temp_c        real not null check (temp_c between -40 and 80),
  created_at    timestamptz not null default clock_timestamp(),
  unique (sensor_id, window_start)
);
create index cabin_air_module_time_idx on public.cabin_air (module_id, window_start desc);
create index cabin_air_time_idx on public.cabin_air (window_start desc);

create type public.procedure_outcome as enum ('in_progress', 'completed', 'aborted');

create table public.procedure_runs (
  id              uuid primary key default gen_random_uuid(),
  protocol        text not null check (protocol ~ '^[a-z0-9_]{1,40}$'),
  patient_crew_id uuid not null references public.crew_members (id) on delete restrict,
  started_by      uuid not null references public.crew_members (id) on delete restrict,
  started_at      timestamptz not null default clock_timestamp(),
  outcome         public.procedure_outcome not null default 'in_progress',
  ended_at        timestamptz,
  ended_by        uuid references public.crew_members (id) on delete restrict,
  notes           text check (notes is null or char_length(notes) <= 2000),
  constraint procedure_runs_end_complete check (
    (outcome = 'in_progress') = (ended_at is null and ended_by is null)
  )
);
create index procedure_runs_started_idx on public.procedure_runs (started_at desc);
create index procedure_runs_patient_idx on public.procedure_runs (patient_crew_id);
create index procedure_runs_started_by_idx on public.procedure_runs (started_by);
create index procedure_runs_ended_by_idx on public.procedure_runs (ended_by);

create table public.procedure_steps (
  run_id   uuid not null references public.procedure_runs (id) on delete restrict,
  step_no  smallint not null check (step_no between 1 and 100),
  done_by  uuid not null references public.crew_members (id) on delete restrict,
  done_at  timestamptz not null default clock_timestamp(),
  primary key (run_id, step_no)
);
create index procedure_steps_done_by_idx on public.procedure_steps (done_by);

-- Starting a run: the starter and time are the caller and now.
create or replace function omni_private.tg_run_start()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := omni_private.current_crew_member_id();
begin
  if v_me is null then
    raise exception 'No active crew identity for this session' using errcode = '42501';
  end if;
  new.started_by := v_me;
  new.started_at := clock_timestamp();
  new.outcome := 'in_progress';
  new.ended_at := null;
  new.ended_by := null;
  return new;
end;
$$;

-- Ending a run: once, stamped; a finished run is read-only (notes too).
create or replace function omni_private.tg_run_end()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.outcome <> 'in_progress' then
    raise exception 'This procedure run has already ended' using errcode = '42501';
  end if;
  if new.outcome <> 'in_progress' then
    new.ended_at := clock_timestamp();
    new.ended_by := omni_private.current_crew_member_id();
  end if;
  return new;
end;
$$;

create or replace function omni_private.tg_step_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_me uuid := omni_private.current_crew_member_id();
begin
  if v_me is null then
    raise exception 'No active crew identity for this session' using errcode = '42501';
  end if;
  if not exists (select 1 from public.procedure_runs r where r.id = new.run_id and r.outcome = 'in_progress') then
    raise exception 'Steps can only be recorded on a run in progress' using errcode = '42501';
  end if;
  new.done_by := v_me;
  new.done_at := clock_timestamp();
  return new;
end;
$$;

create trigger t10_run_start before insert on public.procedure_runs
  for each row execute function omni_private.tg_run_start();
create trigger t10_run_end before update on public.procedure_runs
  for each row execute function omni_private.tg_run_end();
create trigger t10_step_stamp before insert on public.procedure_steps
  for each row execute function omni_private.tg_step_stamp();

alter table public.cabin_air enable row level security;
alter table public.procedure_runs enable row level security;
alter table public.procedure_steps enable row level security;

revoke all on public.cabin_air, public.procedure_runs, public.procedure_steps from anon, authenticated, public;
grant select, insert on public.cabin_air to authenticated;
grant select, insert on public.procedure_runs to authenticated;
grant update (outcome, notes) on public.procedure_runs to authenticated;
grant select, insert on public.procedure_steps to authenticated;

create policy cabin_air_select on public.cabin_air for select to authenticated
  using (omni_private.current_crew_member_id() is not null);
create policy cabin_air_insert on public.cabin_air for insert to authenticated
  with check (omni_private.current_crew_role() = 'sensor_gateway');

create policy runs_select on public.procedure_runs for select to authenticated
  using (omni_private.current_crew_member_id() is not null);
create policy runs_insert on public.procedure_runs for insert to authenticated
  with check (started_by = omni_private.current_crew_member_id());
create policy runs_update on public.procedure_runs for update to authenticated
  using (omni_private.current_crew_member_id() is not null)
  with check (omni_private.current_crew_member_id() is not null);

create policy steps_select on public.procedure_steps for select to authenticated
  using (omni_private.current_crew_member_id() is not null);
create policy steps_insert on public.procedure_steps for insert to authenticated
  with check (done_by = omni_private.current_crew_member_id());
