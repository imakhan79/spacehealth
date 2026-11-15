-- Ground demo only: keeps the public crew demo (spacehealth on Vercel) looking live.
-- NEVER apply on flight hardware: it fabricates telemetry and hard-deletes rows,
-- which the real schema forbids for medical records. That is why it lives in
-- scripts/ and not in supabase/migrations/.
--
-- Every minute: one sample per vital per demo crew member. Every 5 minutes: a
-- dosimeter reading (dose rate + running career total) and a cabin noise
-- window. Demo rows older than 6 hours are pruned.
-- Every 30 minutes: the alert scenario is reset with fresh timestamps, undoing
-- whatever demo visitors acknowledged or overrode.
--
-- All generated rows carry hold_onboard = true, so they never enter uplink_queue.
-- Apply as postgres. Safe to re-run.
--
--   Stop:   select cron.unschedule('omni-demo-vitals'); select cron.unschedule('omni-demo-alerts');
--           select cron.unschedule('omni-demo-messages');
--   Needs supabase/migrations/20261115000300_ground_messages.sql applied first.

create extension if not exists pg_cron;

-- Demo state: when the last solar storm drill started (one row).
create table if not exists omni_private.demo_state (
  id                int primary key default 1 check (id = 1),
  drill_started_at  timestamptz
);
insert into omni_private.demo_state (id) values (1) on conflict do nothing;

-- Dose rate in µSv/h: deep-space background, plus a decaying solar particle
-- event after a drill (≈4,800 at the start, back near background in ~20 min).
create or replace function omni_private.demo_dose_rate(p_at timestamptz)
returns double precision
language sql
stable
set search_path = ''
as $$
  select 75 + coalesce(
    (select case when p_at >= s.drill_started_at and p_at < s.drill_started_at + interval '30 minutes'
                 then 4800 * exp(-extract(epoch from p_at - s.drill_started_at) / 360.0) end
       from omni_private.demo_state s),
    0);
$$;

create or replace function omni_private.demo_vitals_tick()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := date_trunc('minute', clock_timestamp());
  -- Slow swing over ~40 minutes so the heart-rate sparkline has shape.
  v_wave double precision := sin(extract(epoch from v_now) / 382.0);
  -- Minute within the hour, drives SURGEON's early-warning drift.
  v_cycle double precision := extract(minute from v_now);
  c record;
begin
  for c in
    select cm.id, cm.callsign
    from public.crew_members cm
    where cm.callsign in ('CDR', 'SURGEON', 'MS1') and cm.deleted_at is null
  loop
    insert into public.crew_telemetry
      (crew_member_id, metric, value, unit, recorded_at, device_id, signal_quality, hold_onboard)
    values
      (c.id, 'heart_rate',
        round(case c.callsign
          -- SURGEON drifts 80 -> 108 bpm over 45 min, then recovers in 15: it never
          -- crosses 110, but the trend forecast warns for ~20 min of every hour.
          when 'SURGEON' then
            (case when v_cycle < 45 then 80 + v_cycle * 28.0 / 45 else 108 - (v_cycle - 45) * 28.0 / 15 end)
            + (random() - 0.5) * 2
          else (case c.callsign when 'MS1' then 112 else 64 end) + v_wave * 4 + (random() - 0.5) * 4
        end), 'bpm', v_now, 'demo-wearable', 95, true),
      (c.id, 'spo2',
        round(case c.callsign when 'MS1' then 94.5 + (random() - 0.5) else 98 + random() end), '%', v_now, 'demo-wearable', 95, true),
      (c.id, 'respiratory_rate',
        round((case c.callsign when 'MS1' then 21 else 14 end) + v_wave + (random() - 0.5) * 2), 'br/min', v_now, 'demo-wearable', 95, true),
      (c.id, 'core_body_temp',
        round(((case c.callsign when 'MS1' then 37.5 else 36.8 end) + v_wave * 0.1 + (random() - 0.5) * 0.1)::numeric, 2),
        '°C', v_now, 'demo-wearable', 95, true)
    on conflict on constraint crew_telemetry_sample_unique do nothing;
  end loop;

  if extract(minute from v_now)::int % 5 = 0 then
    -- Dosimetry: deep-space background (~75 µSv/h) and a running career total
    -- that grows by rate × 5 min from each member's last reading.
    for c in
      select cm.id, cm.callsign,
             (select t.value from public.crew_telemetry t
               where t.crew_member_id = cm.id and t.metric = 'cumulative_radiation_dose'
               order by t.recorded_at desc limit 1) as last_total
      from public.crew_members cm
      where cm.callsign in ('CDR', 'SURGEON', 'MS1') and cm.deleted_at is null
    loop
      declare
        v_rate double precision := round((omni_private.demo_dose_rate(v_now) + v_wave * 6 + (random() - 0.5) * 8)::numeric, 1);
        v_total double precision := coalesce(c.last_total,
          case c.callsign when 'CDR' then 182.0 when 'SURGEON' then 96.0 else 41.0 end);
      begin
        insert into public.crew_telemetry
          (crew_member_id, metric, value, unit, recorded_at, device_id, signal_quality, hold_onboard)
        values
          (c.id, 'radiation_dose_rate', v_rate, 'µSv/h', v_now, 'demo-dosimeter', 99, true),
          (c.id, 'cumulative_radiation_dose', round((v_total + v_rate * 5 / 60 / 1000)::numeric, 4),
            'mSv', v_now, 'demo-dosimeter', 99, true)
        on conflict on constraint crew_telemetry_sample_unique do nothing;
      end;
    end loop;

    insert into public.ambient_acoustics
      (module_id, sensor_id, window_start, window_seconds, laeq_dba, lmax_dba, limit_exceeded, hold_onboard)
    select m.module_id, m.module_id || '-mic1', v_now - interval '5 minutes', 300,
           m.base + v.jitter, m.base + 8 + v.jitter, m.over, true
    from (values ('habitat-a', 52::real, false), ('galley', 58::real, false), ('eclss-bay', 66::real, true))
           as m(module_id, base, over)
    cross join lateral (select (random() * 3)::real as jitter) v
    on conflict on constraint ambient_acoustics_window_unique do nothing;
  end if;

  -- Demo rows only (fake device, never queued). Real records are never deleted.
  -- The dosimeter's running total is kept: the newest row carries it forward.
  delete from public.crew_telemetry
   where device_id in ('demo-wearable', 'demo-dosimeter') and hold_onboard and recorded_at < v_now - interval '6 hours'
     and not exists (select 1 from public.health_alerts a where a.telemetry_id = crew_telemetry.id);
  delete from public.ambient_acoustics
   where sensor_id like '%-mic1' and hold_onboard and window_start < v_now - interval '6 hours';
end;
$$;

create or replace function omni_private.demo_alerts_reset()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_cdr uuid := (select id from public.crew_members where callsign = 'CDR');
  v_cmo uuid := (select id from public.crew_members where callsign = 'SURGEON');
  v_ms1 uuid := (select id from public.crew_members where callsign = 'MS1');
begin
  if v_cdr is null or v_cmo is null or v_ms1 is null then
    return;
  end if;

  delete from public.health_alerts where hold_onboard;

  insert into public.health_alerts
    (crew_member_id, metric, severity, status, message, triggered_at,
     acknowledged_by, acknowledged_at, overridden_by, overridden_at, override_reason, resolved_at, hold_onboard)
  values
    (v_ms1, 'heart_rate', 'warning', 'active', 'Sustained resting heart rate above 110 bpm for 10 minutes',
      v_now - interval '4 minutes', null, null, null, null, null, null, true),
    (v_ms1, 'spo2', 'caution', 'acknowledged', 'SpO2 trending down: 94% over the last 30 minutes',
      v_now - interval '25 minutes', v_cmo, v_now - interval '20 minutes', null, null, null, null, true),
    (v_cdr, 'heart_rate', 'caution', 'overridden', 'Heart rate 138 bpm',
      v_now - interval '70 minutes', null, null, v_cdr, v_now - interval '68 minutes', 'Scheduled resistance exercise session', null, true),
    (v_cmo, 'core_body_temp', 'advisory', 'resolved', 'Core temperature 37.9 °C after EVA prep',
      v_now - interval '110 minutes', null, null, null, null, null, v_now - interval '90 minutes', true),
    -- Drives the simulated premature beats on the crew ECG monitor.
    (v_ms1, 'heart_rate', 'caution', 'active', 'ECG: occasional premature beats (about 6 per minute)',
      v_now - interval '12 minutes', null, null, null, null, null, null, true);
end;
$$;

-- Simulated Mission Control traffic for the crew inbox: one message every 20
-- minutes from a rotating script, addressed to all crew or to one member.
-- Messages (and their reads) older than 24 hours are removed.
create or replace function omni_private.demo_messages_tick()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_slot int := (extract(epoch from clock_timestamp()) / 1200)::bigint % 6;
  v_to uuid;
begin
  v_to := (select id from public.crew_members
            where callsign = case v_slot when 1 then 'MS1' when 4 then 'CDR' else null end);
  insert into public.ground_messages (author, priority, recipient_crew_id, subject, body, sent_at)
  select m.author, m.priority::public.message_priority, v_to, m.subject, m.body, clock_timestamp() - interval '90 seconds'
  from (values
    (0, 'Flight Director', 'routine', 'Comm pass schedule',
        'Next DSN pass opens in 6 h via Canberra 70 m. Expect ~40 min of contact; uplink backlog will clear first, then science data.'),
    (1, 'Flight Surgeon', 'urgent', 'Heart rate follow-up',
        'We see your resting HR above 110 for the last pass. Please rest 30 min, hydrate 500 ml, and repeat a manual pulse check. Report symptoms if any.'),
    (2, 'Space Weather Office', 'routine', 'Solar activity outlook',
        'Quiet conditions expected for 24 h. Low chance (5%) of an M-class flare. No shelter actions needed; we will advise if that changes.'),
    (3, 'Flight Surgeon', 'routine', 'Weekly private medical conference',
        'PMC slot confirmed for the next comm pass. Please have your exercise log and sleep diary ready.'),
    (4, 'Flight Director', 'routine', 'Crew schedule change',
        'EVA prep moved 24 h later to align with the comm pass. Updated timeline is in the onboard planner.'),
    (5, 'Habitability Team', 'routine', 'Noise in ECLSS bay',
        'Acoustic data shows LAeq above limit in the ECLSS bay. Please wear hearing protection there and check the fan filter at your convenience.')
  ) as m(slot, author, priority, subject, body)
  where m.slot = v_slot;

  delete from public.ground_messages where received_at < clock_timestamp() - interval '24 hours';
end;
$$;

-- Solar storm drill, started from the crew demo's "Run solar storm drill"
-- button. Callable by a signed-in crew member, at most once per 10 minutes.
-- It spikes every demo member's dose rate, raises an emergency alert each
-- (which sounds the cabin alarm) and sends an urgent shelter message. The
-- dose rate then decays through later ticks; the alert reset clears alerts.
create or replace function public.demo_solar_drill()
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_me    uuid := omni_private.current_crew_member_id();
  v_last  timestamptz := (select drill_started_at from omni_private.demo_state where id = 1);
  v_now   timestamptz := clock_timestamp();
  v_rate  double precision;
  c record;
begin
  if v_me is null then
    raise exception 'Sign in as a crew member to run the drill' using errcode = '42501';
  end if;
  if v_last is not null and v_last > v_now - interval '10 minutes' then
    raise exception 'A drill started at % UTC; the next one can start at % UTC',
      to_char(v_last at time zone 'utc', 'HH24:MI'), to_char((v_last + interval '10 minutes') at time zone 'utc', 'HH24:MI')
      using errcode = 'P0001';
  end if;

  update omni_private.demo_state set drill_started_at = v_now where id = 1;
  v_rate := round(omni_private.demo_dose_rate(v_now)::numeric, 0);

  for c in
    select cm.id,
           coalesce((select t.value from public.crew_telemetry t
                      where t.crew_member_id = cm.id and t.metric = 'cumulative_radiation_dose'
                      order by t.recorded_at desc limit 1), 0) as last_total
      from public.crew_members cm
     where cm.callsign in ('CDR', 'SURGEON', 'MS1') and cm.deleted_at is null
  loop
    insert into public.crew_telemetry
      (crew_member_id, metric, value, unit, recorded_at, device_id, signal_quality, hold_onboard)
    values
      (c.id, 'radiation_dose_rate', v_rate, 'µSv/h', v_now, 'demo-dosimeter', 99, true),
      (c.id, 'cumulative_radiation_dose', round((c.last_total + v_rate / 60 / 1000)::numeric, 4), 'mSv', v_now, 'demo-dosimeter', 99, true);
    insert into public.health_alerts (crew_member_id, metric, severity, status, message, triggered_at, hold_onboard)
    values (c.id, 'radiation_dose_rate', 'emergency', 'active',
            format('Solar particle event: dose rate %s µSv/h. Go to the storm shelter now.', to_char(v_rate, 'FM999,999')),
            v_now, true);
  end loop;

  -- The simulated crew (not the visitor) head for the shelter. Done as each of
  -- them, so the location rules apply; the caller's identity is restored after.
  if to_regclass('public.crew_locations') is not null then
    for c in select cm.auth_user_id from public.crew_members cm where cm.callsign in ('SURGEON', 'MS1') loop
      perform set_config('request.jwt.claim.sub', c.auth_user_id::text, true);
      insert into public.crew_locations (module_id) values ('shelter')
      on conflict (crew_member_id) do update set module_id = excluded.module_id;
    end loop;
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  insert into public.ground_messages (author, priority, subject, body, sent_at)
  values ('Space Weather Office', 'urgent', 'DRILL: solar particle event, shelter now',
          'DRILL. Proton flux rising fast after an X-class flare. All crew to the storm shelter now and stay until the dose rate is below 250 µSv/h. Bring your dosimeters and report headcount.',
          v_now - interval '20 seconds');
  return v_now;
end;
$$;
revoke all on function public.demo_solar_drill() from public, anon;
grant execute on function public.demo_solar_drill() to authenticated;

-- Not part of any API: only the cron jobs (running as postgres) call these.
revoke all on function omni_private.demo_vitals_tick() from public, anon, authenticated;
revoke all on function omni_private.demo_alerts_reset() from public, anon, authenticated;
revoke all on function omni_private.demo_messages_tick() from public, anon, authenticated;

select cron.schedule('omni-demo-vitals', '* * * * *', 'select omni_private.demo_vitals_tick()');
select cron.schedule('omni-demo-alerts', '*/30 * * * *', 'select omni_private.demo_alerts_reset()');
select cron.schedule('omni-demo-messages', '*/20 * * * *', 'select omni_private.demo_messages_tick()');
