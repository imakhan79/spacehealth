-- =============================================================================
-- OMNI ambient health monitoring: sleep, nutrition & hydration, life support
--
--   sleep_periods        sleep episodes (wearable-detected or logged by crew)
--   intake_logs          meals and water
--   consumable_readings  stock levels of water, oxygen, food, CO2 cartridges
--
-- Sleep and intake are personal health data: own + medical oversight, as in
-- crew care. The sensor gateway may also record sleep (wearable detection).
-- Supplies are mission data every crew member can read; tank sensors (the
-- gateway) and the commander record levels. Onboard-only (not replicated).
-- =============================================================================

create type public.sleep_source as enum ('wearable', 'manual');

create table public.sleep_periods (
  id             uuid primary key default gen_random_uuid(),
  crew_member_id uuid not null references public.crew_members (id) on delete restrict,
  started_at     timestamptz not null,
  ended_at       timestamptz not null,
  quality        smallint check (quality is null or quality between 1 and 5),
  source         public.sleep_source not null default 'manual',
  created_at     timestamptz not null default clock_timestamp(),
  constraint sleep_periods_order check (ended_at > started_at),
  constraint sleep_periods_length check (ended_at - started_at <= interval '16 hours')
);
create index sleep_periods_member_time_idx on public.sleep_periods (crew_member_id, started_at desc);

create type public.intake_kind as enum ('meal', 'water');

create table public.intake_logs (
  id             uuid primary key default gen_random_uuid(),
  crew_member_id uuid not null references public.crew_members (id) on delete restrict,
  logged_at      timestamptz not null default clock_timestamp(),
  kind           public.intake_kind not null,
  label          text not null check (char_length(label) between 1 and 80),
  kcal           real not null default 0 check (kcal between 0 and 3000),
  protein_g      real not null default 0 check (protein_g between 0 and 300),
  calcium_mg     real not null default 0 check (calcium_mg between 0 and 3000),
  vitamin_d_iu   real not null default 0 check (vitamin_d_iu between 0 and 10000),
  water_ml       real not null default 0 check (water_ml between 0 and 3000)
);
create index intake_logs_member_time_idx on public.intake_logs (crew_member_id, logged_at desc);

create type public.consumable as enum ('water', 'oxygen', 'food', 'co2_cartridges');

create table public.consumable_readings (
  id          uuid primary key default gen_random_uuid(),
  resource    public.consumable not null,
  quantity    real not null check (quantity >= 0),
  measured_at timestamptz not null default clock_timestamp(),
  recorded_by uuid references public.crew_members (id) on delete restrict,
  unique (resource, measured_at)
);
create index consumable_readings_time_idx on public.consumable_readings (resource, measured_at desc);
create index consumable_readings_recorded_by_idx on public.consumable_readings (recorded_by);

-- --- stamping -------------------------------------------------------------------

-- Sleep: crew log their own; the sensor gateway may record for anyone (wearables).
-- Back-dating is limited to 48 h, never in the future.
create or replace function omni_private.tg_sleep_stamp()
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
  if omni_private.current_crew_role() <> 'sensor_gateway' then
    new.crew_member_id := v_me;
    new.source := 'manual';
  end if;
  if new.ended_at > clock_timestamp() + interval '5 minutes' or new.started_at < clock_timestamp() - interval '48 hours' then
    raise exception 'Sleep must be within the last 48 hours' using errcode = '22023';
  end if;
  return new;
end;
$$;

-- Intake: always the caller; logged up to 24 h back, never ahead.
create or replace function omni_private.tg_intake_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.logged_at > clock_timestamp() or new.logged_at < clock_timestamp() - interval '24 hours' then
    new.logged_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create or replace function omni_private.tg_reading_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.recorded_by := omni_private.current_crew_member_id();
  if new.measured_at > clock_timestamp() + interval '5 minutes' then
    new.measured_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create trigger t10_sleep_stamp before insert on public.sleep_periods
  for each row execute function omni_private.tg_sleep_stamp();
create trigger t10_stamp_self before insert on public.intake_logs
  for each row execute function omni_private.tg_stamp_self();
create trigger t20_intake_stamp before insert on public.intake_logs
  for each row execute function omni_private.tg_intake_stamp();
create trigger t10_reading_stamp before insert on public.consumable_readings
  for each row execute function omni_private.tg_reading_stamp();

-- --- privileges and policies ------------------------------------------------------

alter table public.sleep_periods enable row level security;
alter table public.intake_logs enable row level security;
alter table public.consumable_readings enable row level security;

revoke all on public.sleep_periods, public.intake_logs, public.consumable_readings from anon, authenticated, public;
grant select, insert on public.sleep_periods, public.intake_logs, public.consumable_readings to authenticated;

create policy sleep_select on public.sleep_periods for select to authenticated
  using (omni_private.can_see_member(crew_member_id));
create policy sleep_insert on public.sleep_periods for insert to authenticated
  with check (crew_member_id = omni_private.current_crew_member_id() or omni_private.current_crew_role() = 'sensor_gateway');

create policy intake_select on public.intake_logs for select to authenticated
  using (omni_private.can_see_member(crew_member_id));
create policy intake_insert on public.intake_logs for insert to authenticated
  with check (crew_member_id = omni_private.current_crew_member_id());

create policy readings_select on public.consumable_readings for select to authenticated
  using (omni_private.current_crew_member_id() is not null);
create policy readings_insert on public.consumable_readings for insert to authenticated
  with check (omni_private.current_crew_role() in ('sensor_gateway', 'commander'));
