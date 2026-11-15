-- Ground demo only: keeps the public crew demo (spacehealth on Vercel) looking live.
-- NEVER apply on flight hardware: it fabricates telemetry and hard-deletes rows,
-- which the real schema forbids for medical records. That is why it lives in
-- scripts/ and not in supabase/migrations/.
--
-- Every minute: one sample per vital per demo crew member, and a cabin noise
-- window every 5 minutes. Demo rows older than 6 hours are pruned.
-- Every 30 minutes: the alert scenario is reset with fresh timestamps, undoing
-- whatever demo visitors acknowledged or overrode.
--
-- All generated rows carry hold_onboard = true, so they never enter uplink_queue.
-- Apply as postgres. Safe to re-run.
--
--   Stop:   select cron.unschedule('omni-demo-vitals'); select cron.unschedule('omni-demo-alerts');

create extension if not exists pg_cron;

create or replace function omni_private.demo_vitals_tick()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now timestamptz := date_trunc('minute', clock_timestamp());
  -- Slow swing over ~40 minutes so the heart-rate sparkline has shape.
  v_wave double precision := sin(extract(epoch from v_now) / 382.0);
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
        round((case c.callsign when 'MS1' then 112 when 'CDR' then 64 else 71 end)
              + v_wave * 4 + (random() - 0.5) * 4), 'bpm', v_now, 'demo-wearable', 95, true),
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
  delete from public.crew_telemetry
   where device_id = 'demo-wearable' and hold_onboard and recorded_at < v_now - interval '6 hours'
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
      v_now - interval '110 minutes', null, null, null, null, null, v_now - interval '90 minutes', true);
end;
$$;

-- Not part of any API: only the cron jobs (running as postgres) call these.
revoke all on function omni_private.demo_vitals_tick() from public, anon, authenticated;
revoke all on function omni_private.demo_alerts_reset() from public, anon, authenticated;

select cron.schedule('omni-demo-vitals', '* * * * *', 'select omni_private.demo_vitals_tick()');
select cron.schedule('omni-demo-alerts', '*/30 * * * *', 'select omni_private.demo_alerts_reset()');
