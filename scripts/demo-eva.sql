-- Ground demo only: an always-running spacewalk for the crew demo's EVA
-- monitor. NEVER apply on flight hardware. Needs migration 20261115000700_eva.sql.
--
-- 8-hour blocks from 00:00, 08:00 and 16:00 UTC: 100 min prebreathe, then a
-- 6 h EVA by SURGEON (EV1) and MS1 (EV2), then a short gap. Every minute the
-- job writes any missing suit telemetry (so the live block has full history).
-- Every third block, MS1's suit develops a slow leak 3 h in: an emergency
-- alert sounds the cabin alarm; if no one terminates the EVA within 20 min,
-- the demo terminates it and records why.
--
--   Stop:   select cron.unschedule('omni-demo-eva');

create or replace function omni_private.demo_eva_tick()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now     timestamptz := clock_timestamp();
  v_block   bigint := floor(extract(epoch from v_now) / (8 * 3600));
  v_start   timestamptz := to_timestamp(v_block * 8 * 3600);
  v_egress  timestamptz := v_start + interval '100 minutes';
  v_planned int := 360;
  v_leak    boolean := v_block % 3 = 2;
  v_ev1     uuid := (select id from public.crew_members where callsign = 'SURGEON');
  v_ev2     uuid := (select id from public.crew_members where callsign = 'MS1');
  s         public.eva_sessions;
  v_minutes int;
begin
  if v_ev1 is null or v_ev2 is null then
    return;
  end if;

  -- This block's EVA (created once).
  select * into s from public.eva_sessions where prebreathe_start = v_start;
  if not found then
    insert into public.eva_sessions (ev1, ev2, objective, prebreathe_start, egress_at, planned_minutes, status)
    values (v_ev1, v_ev2,
            (array['Replace external pump module', 'Install solar array bracket', 'Inspect radiator panel'])[1 + (v_block % 3)::int],
            v_start, v_egress, v_planned, 'prebreathe')
    returning * into s;
  end if;

  -- Phase changes.
  if s.status = 'prebreathe' and v_now >= s.egress_at then
    update public.eva_sessions set status = 'eva' where id = s.id returning * into s;
  end if;
  if s.status = 'eva' and v_now >= s.egress_at + make_interval(mins => s.planned_minutes) then
    update public.eva_sessions set status = 'complete' where id = s.id returning * into s;
  end if;

  -- Telemetry for every elapsed EVA minute not yet written (until it ended).
  if s.status in ('eva', 'complete', 'aborted') then
    v_minutes := least(
      floor(extract(epoch from least(v_now, coalesce(s.ended_at, v_now)) - s.egress_at) / 60)::int,
      s.planned_minutes);
    insert into public.suit_telemetry
      (session_id, crew_member_id, recorded_at, suit_pressure_kpa, co2_mmhg, o2_pct, battery_pct, feedwater_pct, scrubber_pct, heart_rate, suit_temp_c)
    select s.id, m.id, s.egress_at + make_interval(mins => e),
           case when m.ev = 2 and v_leak and e > 180 then greatest(20, 29.6 - 0.025 * (e - 180)) else 29.6 + 0.04 * sin(e / 5.0) end,
           2.0 + 0.6 * sin(e / 11.0 + m.ev) + case when m.ev = 2 then 0.4 else 0 end,
           greatest(0, 100 - e * 0.19 - m.ev),
           greatest(0, 100 - e * 0.21),
           greatest(0, 100 - e * 0.17 - m.ev * 2),
           greatest(0, 100 - e * 0.2),
           case m.ev when 1 then 95 + 15 * sin(e / 9.0) else 108 + 20 * sin(e / 7.0) end,
           20.5 + sin(e / 13.0)
      from generate_series(0, v_minutes) e
     cross join (values (v_ev1, 1), (v_ev2, 2)) m(id, ev)
    on conflict (crew_member_id, recorded_at) do nothing;
  end if;

  -- The leak: alarm while it lasts; terminate if nobody has after 20 min.
  if s.status = 'eva' and v_leak and v_now > s.egress_at + interval '180 minutes' then
    if not exists (select 1 from public.health_alerts a
                    where a.crew_member_id = v_ev2 and a.status = 'active' and a.message like 'EVA: suit pressure falling%') then
      insert into public.health_alerts (crew_member_id, severity, status, message, triggered_at, hold_onboard)
      values (v_ev2, 'emergency', 'active', 'EVA: suit pressure falling, possible leak. Terminate EVA and return to the airlock.', v_now, true);
    end if;
    if v_now > s.egress_at + interval '200 minutes' then
      update public.eva_sessions set status = 'aborted', end_reason = 'Suit leak (EV2); terminated automatically by the demo after 20 min'
       where id = s.id;
    end if;
  end if;

  delete from public.suit_telemetry where recorded_at < v_now - interval '2 days';
  delete from public.eva_sessions where prebreathe_start < v_now - interval '7 days';
end;
$$;
revoke all on function omni_private.demo_eva_tick() from public, anon, authenticated;

select omni_private.demo_eva_tick();
select cron.schedule('omni-demo-eva', '* * * * *', 'select omni_private.demo_eva_tick()');
