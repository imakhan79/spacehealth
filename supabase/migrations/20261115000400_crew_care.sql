-- =============================================================================
-- OMNI ambient health monitoring: crew care
--
--   wellness_checkins      daily self-report (sleep, fatigue, mood, symptoms)
--   medications            prescriptions, set by medical oversight
--   medication_doses       one row per dose taken
--   medical_inventory      medical kit stock, expiry and minimums
--   exercise_prescriptions weekly countermeasure minutes per crew member/kind
--   exercise_sessions      logged exercise
--   crew_locations         which module each crew member is in
--
-- Access pattern, as elsewhere: crew read and write their own records; the
-- flight surgeon and commander (medical oversight) read everyone's. Who and
-- when are stamped server-side; client-supplied values are overwritten.
-- These are onboard-only tables (not replicated to Earth).
-- =============================================================================

-- --- shared helpers -----------------------------------------------------------

create or replace function omni_private.can_see_member(p_member uuid)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_member = omni_private.current_crew_member_id() or omni_private.has_medical_oversight();
$$;

-- BEFORE INSERT/UPDATE: the row belongs to the caller. RLS then checks it.
create or replace function omni_private.tg_stamp_self()
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
  new.crew_member_id := v_me;
  return new;
end;
$$;

grant execute on function omni_private.can_see_member(uuid) to authenticated;

-- --- wellness check-ins ---------------------------------------------------------

create table public.wellness_checkins (
  id             uuid primary key default gen_random_uuid(),
  crew_member_id uuid not null references public.crew_members (id) on delete restrict,
  checkin_date   date not null default (clock_timestamp() at time zone 'utc')::date,
  sleep_hours    numeric(3, 1) not null check (sleep_hours between 0 and 16),
  fatigue        smallint not null check (fatigue between 1 and 5),   -- 1 rested .. 5 exhausted
  mood           smallint not null check (mood between 1 and 5),      -- 1 very low .. 5 very good
  symptoms       text[] not null default '{}' check (
                   symptoms <@ array['headache', 'nausea', 'congestion', 'back_pain', 'eye_strain',
                                     'insomnia', 'dizziness', 'skin_irritation', 'none']::text[]
                   and cardinality(symptoms) <= 9),
  note           text check (note is null or char_length(note) <= 500),
  updated_at     timestamptz not null default clock_timestamp(),
  unique (crew_member_id, checkin_date)
);

create or replace function omni_private.tg_checkin_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  if tg_op = 'UPDATE' then
    -- Only today's check-in can be revised, and never moved to another member or day.
    new.crew_member_id := old.crew_member_id;
    new.checkin_date := old.checkin_date;
    if old.checkin_date <> (clock_timestamp() at time zone 'utc')::date then
      raise exception 'Only today''s check-in can be changed' using errcode = '42501';
    end if;
  else
    new.checkin_date := (clock_timestamp() at time zone 'utc')::date;
  end if;
  return new;
end;
$$;

create trigger t10_stamp_self before insert on public.wellness_checkins
  for each row execute function omni_private.tg_stamp_self();
create trigger t20_checkin_stamp before insert or update on public.wellness_checkins
  for each row execute function omni_private.tg_checkin_stamp();

-- --- medications ----------------------------------------------------------------

create table public.medications (
  id             uuid primary key default gen_random_uuid(),
  crew_member_id uuid not null references public.crew_members (id) on delete restrict,
  name           text not null check (char_length(name) between 1 and 80),
  dose           text not null check (char_length(dose) between 1 and 80),
  instructions   text check (instructions is null or char_length(instructions) <= 300),
  -- Times of day (UTC) each dose is due.
  schedule_utc   time[] not null check (cardinality(schedule_utc) between 1 and 8),
  active         boolean not null default true,
  prescribed_by  uuid references public.crew_members (id) on delete restrict,
  created_at     timestamptz not null default clock_timestamp()
);

create table public.medication_doses (
  id             uuid primary key default gen_random_uuid(),
  medication_id  uuid not null references public.medications (id) on delete restrict,
  crew_member_id uuid not null references public.crew_members (id) on delete restrict,
  -- The scheduled slot this dose fulfils, so a slot is never taken twice.
  due_at         timestamptz not null,
  taken_at       timestamptz not null default clock_timestamp(),
  unique (medication_id, due_at)
);

create or replace function omni_private.tg_dose_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.taken_at := clock_timestamp();
  -- A dose can only be logged for your own active medication, for a slot
  -- within the last 12 h or the next hour.
  if not exists (
    select 1 from public.medications m
     where m.id = new.medication_id and m.crew_member_id = new.crew_member_id and m.active
  ) then
    raise exception 'Not one of your active medications' using errcode = '42501';
  end if;
  if new.due_at < new.taken_at - interval '12 hours' or new.due_at > new.taken_at + interval '1 hour' then
    raise exception 'That dose is not due now' using errcode = '22023';
  end if;
  return new;
end;
$$;

create trigger t10_stamp_self before insert on public.medication_doses
  for each row execute function omni_private.tg_stamp_self();
create trigger t20_dose_stamp before insert on public.medication_doses
  for each row execute function omni_private.tg_dose_stamp();

-- Oversight prescribes; the prescriber is stamped.
create or replace function omni_private.tg_prescriber_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.prescribed_by := omni_private.current_crew_member_id();
  return new;
end;
$$;

create trigger t10_prescriber_stamp before insert on public.medications
  for each row execute function omni_private.tg_prescriber_stamp();

-- --- medical kit inventory --------------------------------------------------------

create table public.medical_inventory (
  id           uuid primary key default gen_random_uuid(),
  item         text not null unique check (char_length(item) between 1 and 80),
  category     text not null check (category in ('medication', 'wound_care', 'diagnostic', 'emergency', 'hygiene')),
  quantity     integer not null check (quantity >= 0),
  unit         text not null check (char_length(unit) between 1 and 16),
  min_quantity integer not null default 0 check (min_quantity >= 0),
  expires_on   date,
  location     text not null check (char_length(location) between 1 and 64),
  updated_at   timestamptz not null default clock_timestamp(),
  updated_by   uuid references public.crew_members (id) on delete restrict
);

create or replace function omni_private.tg_inventory_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  new.updated_by := omni_private.current_crew_member_id();
  return new;
end;
$$;

create trigger t10_inventory_stamp before update on public.medical_inventory
  for each row execute function omni_private.tg_inventory_stamp();

-- --- exercise countermeasures -------------------------------------------------------

create type public.exercise_kind as enum ('treadmill', 'resistance', 'cycle');

create table public.exercise_prescriptions (
  crew_member_id uuid not null references public.crew_members (id) on delete restrict,
  kind           public.exercise_kind not null,
  weekly_minutes integer not null check (weekly_minutes between 0 and 2000),
  primary key (crew_member_id, kind)
);

create table public.exercise_sessions (
  id             uuid primary key default gen_random_uuid(),
  crew_member_id uuid not null references public.crew_members (id) on delete restrict,
  kind           public.exercise_kind not null,
  minutes        integer not null check (minutes between 1 and 240),
  performed_at   timestamptz not null default clock_timestamp(),
  note           text check (note is null or char_length(note) <= 200)
);

create or replace function omni_private.tg_session_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- Logged sessions may be back-dated up to 24 h (logged after the workout), never future.
  if new.performed_at > clock_timestamp() or new.performed_at < clock_timestamp() - interval '24 hours' then
    new.performed_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create trigger t10_stamp_self before insert on public.exercise_sessions
  for each row execute function omni_private.tg_stamp_self();
create trigger t20_session_stamp before insert on public.exercise_sessions
  for each row execute function omni_private.tg_session_stamp();

-- --- crew locations ----------------------------------------------------------------

create table public.crew_locations (
  crew_member_id uuid primary key references public.crew_members (id) on delete restrict,
  module_id      text not null check (char_length(module_id) between 1 and 64),
  updated_at     timestamptz not null default clock_timestamp()
);

create or replace function omni_private.tg_location_stamp()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := clock_timestamp();
  return new;
end;
$$;

create trigger t10_stamp_self before insert or update on public.crew_locations
  for each row execute function omni_private.tg_stamp_self();
create trigger t20_location_stamp before insert or update on public.crew_locations
  for each row execute function omni_private.tg_location_stamp();

create index wellness_checkins_member_date_idx on public.wellness_checkins (crew_member_id, checkin_date desc);
create index medications_member_idx on public.medications (crew_member_id);
create index medications_prescribed_by_idx on public.medications (prescribed_by);
create index medication_doses_member_idx on public.medication_doses (crew_member_id, due_at desc);
create index medical_inventory_updated_by_idx on public.medical_inventory (updated_by);
create index exercise_sessions_member_time_idx on public.exercise_sessions (crew_member_id, performed_at desc);

-- --- privileges and policies --------------------------------------------------------

alter table public.wellness_checkins enable row level security;
alter table public.medications enable row level security;
alter table public.medication_doses enable row level security;
alter table public.medical_inventory enable row level security;
alter table public.exercise_prescriptions enable row level security;
alter table public.exercise_sessions enable row level security;
alter table public.crew_locations enable row level security;

revoke all on public.wellness_checkins, public.medications, public.medication_doses, public.medical_inventory,
              public.exercise_prescriptions, public.exercise_sessions, public.crew_locations
  from anon, authenticated, public;

grant select, insert on public.wellness_checkins to authenticated;
grant update (sleep_hours, fatigue, mood, symptoms, note) on public.wellness_checkins to authenticated;
grant select, insert on public.medications to authenticated;
grant update (active, instructions) on public.medications to authenticated;
grant select, insert on public.medication_doses to authenticated;
grant select on public.medical_inventory to authenticated;
grant update (quantity) on public.medical_inventory to authenticated;
grant select on public.exercise_prescriptions to authenticated;
grant select, insert on public.exercise_sessions to authenticated;
grant select, insert on public.crew_locations to authenticated;
grant update (module_id) on public.crew_locations to authenticated;

-- Wellness: own + oversight read; write only your own (and only today's, by trigger).
create policy wellness_select on public.wellness_checkins for select to authenticated
  using (omni_private.can_see_member(crew_member_id));
create policy wellness_insert on public.wellness_checkins for insert to authenticated
  with check (crew_member_id = omni_private.current_crew_member_id());
create policy wellness_update on public.wellness_checkins for update to authenticated
  using (crew_member_id = omni_private.current_crew_member_id())
  with check (crew_member_id = omni_private.current_crew_member_id());

-- Medications: own + oversight read; only oversight prescribes or changes them.
create policy medications_select on public.medications for select to authenticated
  using (omni_private.can_see_member(crew_member_id));
create policy medications_insert on public.medications for insert to authenticated
  with check (omni_private.has_medical_oversight());
create policy medications_update on public.medications for update to authenticated
  using (omni_private.has_medical_oversight())
  with check (omni_private.has_medical_oversight());

create policy doses_select on public.medication_doses for select to authenticated
  using (omni_private.can_see_member(crew_member_id));
create policy doses_insert on public.medication_doses for insert to authenticated
  with check (crew_member_id = omni_private.current_crew_member_id());

-- Medical kit: every crew member can see it and record what they used.
create policy inventory_select on public.medical_inventory for select to authenticated
  using (omni_private.current_crew_member_id() is not null);
create policy inventory_update on public.medical_inventory for update to authenticated
  using (omni_private.current_crew_member_id() is not null)
  with check (omni_private.current_crew_member_id() is not null);

create policy rx_select on public.exercise_prescriptions for select to authenticated
  using (omni_private.can_see_member(crew_member_id));
create policy sessions_select on public.exercise_sessions for select to authenticated
  using (omni_private.can_see_member(crew_member_id));
create policy sessions_insert on public.exercise_sessions for insert to authenticated
  with check (crew_member_id = omni_private.current_crew_member_id());

-- Locations: everyone aboard can see where everyone is (safety); you set your own.
create policy locations_select on public.crew_locations for select to authenticated
  using (omni_private.current_crew_member_id() is not null);
create policy locations_insert on public.crew_locations for insert to authenticated
  with check (crew_member_id = omni_private.current_crew_member_id());
create policy locations_update on public.crew_locations for update to authenticated
  using (crew_member_id = omni_private.current_crew_member_id())
  with check (crew_member_id = omni_private.current_crew_member_id());

-- Taking items from the kit: atomic, never below zero. Runs as the caller
-- (security invoker), so the column grant and RLS above still apply.
create or replace function public.use_medical_item(p_item uuid, p_count integer default 1)
returns integer
language sql
security invoker
set search_path = ''
as $$
  update public.medical_inventory
     set quantity = quantity - p_count
   where id = p_item and p_count between 1 and 100 and quantity >= p_count
  returning quantity;
$$;
revoke all on function public.use_medical_item(uuid, integer) from public, anon;
grant execute on function public.use_medical_item(uuid, integer) to authenticated;
