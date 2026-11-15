-- Ground demo only: crew care data for the public crew demo (spacehealth on
-- Vercel). NEVER apply on flight hardware. Needs migration
-- 20261115000400_crew_care.sql and scripts/demo-live-vitals.sql first.
--
-- Part 1 (once): the medical kit, prescriptions and 14 days of history.
--   History is back-dated, which the "today only" triggers forbid, so it is
--   inserted with those triggers briefly disabled inside one transaction.
-- Part 2 (every 10 min, pg_cron): SURGEON and MS1 live their day. The job
--   acts *as* each of them (sets the JWT subject for its transaction), so their
--   rows pass through exactly the same triggers and RLS as a real crew member's.
--   CDR is left to the demo visitor.
--
--   Stop:   select cron.unschedule('omni-demo-care');

-- --- Part 1: seed -------------------------------------------------------------------

do $$
declare
  v_cdr uuid := (select id from public.crew_members where callsign = 'CDR');
  v_cmo uuid := (select id from public.crew_members where callsign = 'SURGEON');
  v_ms1 uuid := (select id from public.crew_members where callsign = 'MS1');
  v_today date := (now() at time zone 'utc')::date;
begin
  if exists (select 1 from public.medical_inventory) then
    raise notice 'crew care demo already seeded';
    return;
  end if;

  insert into public.medical_inventory (item, category, quantity, unit, min_quantity, expires_on, location) values
    ('Ibuprofen 200 mg', 'medication', 38, 'tablets', 20, v_today + 400, 'Med kit A'),
    ('Paracetamol 500 mg', 'medication', 12, 'tablets', 20, v_today + 300, 'Med kit A'),
    ('Promethazine 25 mg', 'medication', 6, 'tablets', 4, v_today + 21, 'Med kit A'),
    ('Melatonin 3 mg', 'medication', 40, 'tablets', 14, v_today + 500, 'Med kit A'),
    ('Loratadine 10 mg', 'medication', 22, 'tablets', 10, v_today - 3, 'Med kit A'),
    ('Sterile gauze 10 cm', 'wound_care', 30, 'pads', 10, v_today + 900, 'Med kit B'),
    ('Skin closure strips', 'wound_care', 3, 'packs', 4, v_today + 700, 'Med kit B'),
    ('Pulse oximeter batteries', 'diagnostic', 8, 'cells', 4, null, 'Med kit B'),
    ('Epinephrine auto-injector', 'emergency', 2, 'pens', 2, v_today + 45, 'Emergency pack'),
    ('Eye wash 500 ml', 'emergency', 0, 'bottles', 1, v_today + 600, 'Emergency pack');

  insert into public.exercise_prescriptions (crew_member_id, kind, weekly_minutes)
  select m, k.kind::public.exercise_kind, k.minutes
    from unnest(array[v_cdr, v_cmo, v_ms1]) m
   cross join (values ('treadmill', 150), ('resistance', 180), ('cycle', 90)) k(kind, minutes);

  -- Prescriptions (prescriber stamped by trigger; seeded as the flight surgeon).
  perform set_config('request.jwt.claim.sub', (select auth_user_id::text from public.crew_members where id = v_cmo), true);
  insert into public.medications (crew_member_id, name, dose, instructions, schedule_utc) values
    (v_cdr, 'Melatonin', '3 mg', 'Before the sleep period.', '{21:00}'),
    (v_cdr, 'Vitamin D3', '1000 IU', 'With breakfast.', '{08:00}'),
    (v_cmo, 'Loratadine', '10 mg', 'For cabin-air congestion.', '{08:00}'),
    (v_ms1, 'Vitamin D3', '1000 IU', 'With breakfast.', '{08:00}'),
    (v_ms1, 'Omega-3', '1 g', 'With meals.', '{08:00,20:00}');
  perform set_config('request.jwt.claim.sub', '', true);

  alter table public.wellness_checkins disable trigger user;
  alter table public.exercise_sessions disable trigger user;
  alter table public.crew_locations disable trigger user;

  -- 14 days of check-ins (not today's for CDR: that one is the visitor's).
  -- SURGEON sleeps badly lately; MS1 is tired.
  insert into public.wellness_checkins (crew_member_id, checkin_date, sleep_hours, fatigue, mood, symptoms, note, updated_at)
  select c.id, v_today - d,
         case c.cs
           when 'SURGEON' then case when d <= 3 then 5.0 + (d % 2) * 0.5 else 7.0 + (d % 3) * 0.5 end
           when 'MS1' then 6.5 + (d % 2) * 0.5
           else 7.0 + (d % 4) * 0.25 end,
         case c.cs when 'MS1' then case when d <= 1 then 4 else 3 end when 'SURGEON' then case when d <= 3 then 3 else 2 end else 2 end,
         case c.cs when 'SURGEON' then case when d <= 3 then 3 else 4 end else 4 end,
         case when c.cs = 'MS1' and d <= 2 then '{headache,congestion}'::text[]
              when c.cs = 'SURGEON' and d <= 3 then '{insomnia}'::text[]
              else '{none}'::text[] end,
         case when c.cs = 'SURGEON' and d = 0 then 'Woke up 3 times; fan noise near the sleep station.' end,
         (v_today - d) + time '07:30'
    from (values (v_cdr, 'CDR'), (v_cmo, 'SURGEON'), (v_ms1, 'MS1')) c(id, cs)
   cross join generate_series(0, 13) d
   where not (c.cs = 'CDR' and d = 0);

  -- A week of exercise: CDR on target, SURGEON partial, MS1 behind.
  insert into public.exercise_sessions (crew_member_id, kind, minutes, performed_at)
  -- Fixed pattern (not random): CDR trains daily, SURGEON 2 days in 3, MS1 1 in 3.
  select c.id, k.kind::public.exercise_kind, k.minutes, now() - make_interval(days => d, hours => k.hour_offset)
    from (values (v_cdr, 1), (v_cmo, 2), (v_ms1, 3)) c(id, every)
   cross join generate_series(1, 6) d
   cross join (values ('treadmill', 25, 3), ('resistance', 30, 6), ('cycle', 15, 9)) k(kind, minutes, hour_offset)
   where c.every = 1 or (c.every = 2 and d % 3 <> 0) or (c.every = 3 and d % 3 = 0);

  insert into public.crew_locations (crew_member_id, module_id) values
    (v_cdr, 'galley'), (v_cmo, 'lab'), (v_ms1, 'habitat-a');

  alter table public.wellness_checkins enable trigger user;
  alter table public.exercise_sessions enable trigger user;
  alter table public.crew_locations enable trigger user;
end;
$$;

-- --- Part 2: live day -----------------------------------------------------------------

create or replace function omni_private.demo_care_tick()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_minute  int := extract(hour from v_now at time zone 'utc')::int * 60 + extract(minute from v_now at time zone 'utc')::int;
  v_rot     text[] := array['lab', 'galley', 'habitat-a', 'eclss-bay', 'node-1', 'lab'];
  c record;
  m record;
begin
  for c in
    select cm.id, cm.callsign, cm.auth_user_id from public.crew_members cm where cm.callsign in ('SURGEON', 'MS1')
  loop
    -- Act as this crew member for the rest of this loop iteration.
    perform set_config('request.jwt.claim.sub', c.auth_user_id::text, true);

    -- Morning check-in once the day has started (07:00Z).
    if v_minute >= 7 * 60 then
      insert into public.wellness_checkins (sleep_hours, fatigue, mood, symptoms, note)
      values (
        case c.callsign when 'SURGEON' then 5.5 else 7.0 end,
        case c.callsign when 'SURGEON' then 3 else 4 end,
        case c.callsign when 'SURGEON' then 3 else 4 end,
        case c.callsign when 'SURGEON' then '{insomnia}'::text[] else '{headache}'::text[] end,
        case c.callsign when 'SURGEON' then 'Woke up 3 times; fan noise near the sleep station.' end)
      on conflict (crew_member_id, checkin_date) do nothing;
    end if;

    -- Take doses ~10 min after they are due; MS1 forgets the morning Omega-3.
    for m in
      select med.id, med.name, s.slot
        from public.medications med
       cross join lateral unnest(med.schedule_utc) s(slot)
       where med.crew_member_id = c.id and med.active
    loop
      declare
        -- Today's slot at that UTC wall-clock time.
        v_due timestamptz := ((v_now at time zone 'utc')::date + m.slot) at time zone 'utc';
      begin
        if v_due + interval '10 minutes' <= v_now and v_due > v_now - interval '11 hours'
           and not (c.callsign = 'MS1' and m.name = 'Omega-3' and m.slot = time '08:00') then
          insert into public.medication_doses (medication_id, due_at) values (m.id, v_due)
          on conflict (medication_id, due_at) do nothing;
        end if;
      end;
    end loop;

    -- Workouts: SURGEON treadmill at 10:00Z, MS1 resistance at 15:00Z.
    if (c.callsign = 'SURGEON' and v_minute between 10 * 60 + 30 and 10 * 60 + 39)
       or (c.callsign = 'MS1' and v_minute between 15 * 60 + 45 and 15 * 60 + 54) then
      insert into public.exercise_sessions (kind, minutes, performed_at)
      values (case c.callsign when 'SURGEON' then 'treadmill' else 'resistance' end::public.exercise_kind,
              case c.callsign when 'SURGEON' then 30 else 45 end, v_now - interval '5 minutes');
    end if;

    -- Move around the habitat (not during a storm drill: they stay sheltered).
    if not exists (select 1 from omni_private.demo_state s where s.drill_started_at > v_now - interval '20 minutes') then
      insert into public.crew_locations (module_id)
      values (v_rot[1 + ((v_minute / 10) + case c.callsign when 'MS1' then 2 else 0 end) % array_length(v_rot, 1)])
      on conflict (crew_member_id) do update set module_id = excluded.module_id;
    end if;
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);

  delete from public.wellness_checkins where checkin_date < (v_now at time zone 'utc')::date - 30;
  delete from public.exercise_sessions where performed_at < v_now - interval '30 days';
end;
$$;
revoke all on function omni_private.demo_care_tick() from public, anon, authenticated;

select cron.schedule('omni-demo-care', '*/10 * * * *', 'select omni_private.demo_care_tick()');
