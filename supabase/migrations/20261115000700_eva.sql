-- =============================================================================
-- OMNI ambient health monitoring: EVA (spacewalk) monitoring
--
--   eva_sessions    one spacewalk: two crew (EV1, EV2), prebreathe, egress,
--                   planned duration, status
--   suit_telemetry  per-minute suit and crew readings during the EVA
--
-- EVA data is operational safety data: every crew member aboard can read it
-- (the intravehicular operator watches both suits). Only the sensor gateway
-- writes telemetry; only the commander plans, starts or terminates an EVA,
-- and who ended it and when is stamped server-side. Onboard-only.
-- =============================================================================

create type public.eva_status as enum ('planned', 'prebreathe', 'eva', 'complete', 'aborted');

create table public.eva_sessions (
  id                   uuid primary key default gen_random_uuid(),
  ev1                  uuid not null references public.crew_members (id) on delete restrict,
  ev2                  uuid not null references public.crew_members (id) on delete restrict,
  objective            text not null check (char_length(objective) between 1 and 200),
  prebreathe_start     timestamptz not null,
  egress_at            timestamptz not null,
  planned_minutes      integer not null check (planned_minutes between 30 and 600),
  status               public.eva_status not null default 'planned',
  ended_at             timestamptz,
  ended_by             uuid references public.crew_members (id) on delete restrict,
  end_reason           text check (end_reason is null or char_length(end_reason) <= 300),
  created_at           timestamptz not null default clock_timestamp(),
  constraint eva_two_crew check (ev1 <> ev2),
  constraint eva_order check (egress_at > prebreathe_start)
);
create index eva_sessions_time_idx on public.eva_sessions (egress_at desc);
create index eva_sessions_ev1_idx on public.eva_sessions (ev1);
create index eva_sessions_ev2_idx on public.eva_sessions (ev2);
create index eva_sessions_ended_by_idx on public.eva_sessions (ended_by);

create table public.suit_telemetry (
  id                 uuid primary key default gen_random_uuid(),
  session_id         uuid not null references public.eva_sessions (id) on delete cascade,
  crew_member_id     uuid not null references public.crew_members (id) on delete restrict,
  recorded_at        timestamptz not null,
  suit_pressure_kpa  real not null check (suit_pressure_kpa between 0 and 60),
  co2_mmhg           real not null check (co2_mmhg between 0 and 60),
  o2_pct             real not null check (o2_pct between 0 and 100),
  battery_pct        real not null check (battery_pct between 0 and 100),
  feedwater_pct      real not null check (feedwater_pct between 0 and 100),
  scrubber_pct       real not null check (scrubber_pct between 0 and 100),
  heart_rate         real not null check (heart_rate between 0 and 250),
  suit_temp_c        real not null check (suit_temp_c between -50 and 80),
  unique (crew_member_id, recorded_at)
);
create index suit_telemetry_session_time_idx on public.suit_telemetry (session_id, recorded_at desc);

-- Ending an EVA: once, stamped with who and when; a finished EVA is read-only.
create or replace function omni_private.tg_eva_end()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('complete', 'aborted') then
    raise exception 'This EVA has already ended' using errcode = '42501';
  end if;
  if new.status in ('complete', 'aborted') then
    new.ended_at := clock_timestamp();
    new.ended_by := omni_private.current_crew_member_id();
  end if;
  return new;
end;
$$;

create trigger t10_eva_end before update on public.eva_sessions
  for each row execute function omni_private.tg_eva_end();

alter table public.eva_sessions enable row level security;
alter table public.suit_telemetry enable row level security;

revoke all on public.eva_sessions, public.suit_telemetry from anon, authenticated, public;
grant select, insert on public.eva_sessions to authenticated;
grant update (status, end_reason) on public.eva_sessions to authenticated;
grant select, insert on public.suit_telemetry to authenticated;

create policy eva_select on public.eva_sessions for select to authenticated
  using (omni_private.current_crew_member_id() is not null);
create policy eva_insert on public.eva_sessions for insert to authenticated
  with check (omni_private.current_crew_role() = 'commander');
create policy eva_update on public.eva_sessions for update to authenticated
  using (omni_private.current_crew_role() = 'commander')
  with check (omni_private.current_crew_role() = 'commander');

create policy suit_select on public.suit_telemetry for select to authenticated
  using (omni_private.current_crew_member_id() is not null);
create policy suit_insert on public.suit_telemetry for insert to authenticated
  with check (omni_private.current_crew_role() = 'sensor_gateway');
