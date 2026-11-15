-- Ground demo only: cabin air readings and a procedure history for the public
-- crew demo. NEVER apply on flight hardware. Needs migration
-- 20261115000500_air_and_procedures.sql and scripts/demo-crew-care.sql first.
--
-- Air is written every 5 minutes *as the SENSORS gateway account*, so it goes
-- through the same "only the sensor gateway writes" rule as real sensors.
-- CO2 rises with the number of crew in a module, and the ECLSS bay's scrubber
-- falls behind for ~30 min every 2 hours (CO2 into the caution range).
--
--   Stop:   select cron.unschedule('omni-demo-air');

create or replace function omni_private.demo_air_reading(p_module text, p_at timestamptz, p_people int)
returns table (co2 real, o2 real, rh real, temp real)
language sql
stable
set search_path = ''
as $$
  select
    ((case p_module
        when 'habitat-a' then 850 when 'galley' then 1050 when 'lab' then 950 when 'eclss-bay' then 1300
        when 'node-1' then 800 when 'shelter' then 750 else 700 end)
      + p_people * 320
      -- ECLSS scrubber lag: minutes 60..89 of every 2 h block, peaking ~3,100 ppm.
      + case when p_module = 'eclss-bay'
               and (extract(epoch from p_at)::bigint / 60) % 120 between 60 and 89
             then 1800 * sin(pi() * ((extract(epoch from p_at)::bigint / 60) % 120 - 60) / 30.0)
             else 0 end
      + (random() - 0.5) * 60)::real,
    (20.9 + (random() - 0.5) * 0.3)::real,
    ((case p_module when 'galley' then 57 when 'shelter' then 48 else 44 end) + (random() - 0.5) * 4)::real,
    ((case p_module when 'eclss-bay' then 25.6 when 'galley' then 23.4 else 22.4 end) + (random() - 0.5) * 0.6)::real;
$$;

create or replace function omni_private.demo_air_tick(p_at timestamptz default clock_timestamp())
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_at timestamptz := date_trunc('minute', p_at) - make_interval(mins => extract(minute from p_at)::int % 5);
  v_gw uuid := (select auth_user_id from public.crew_members where role = 'sensor_gateway' limit 1);
begin
  if v_gw is null then
    return;
  end if;
  perform set_config('request.jwt.claim.sub', v_gw::text, true);
  insert into public.cabin_air (module_id, sensor_id, window_start, co2_ppm, o2_pct, humidity_pct, temp_c)
  select m.id, m.id || '-air1', v_at, r.co2, r.o2, r.rh, r.temp
    from unnest(array['airlock', 'node-1', 'habitat-a', 'galley', 'lab', 'eclss-bay', 'shelter']) m(id)
   cross join lateral omni_private.demo_air_reading(
     m.id, v_at, (select count(*)::int from public.crew_locations l where l.module_id = m.id)) r
  on conflict (sensor_id, window_start) do nothing;
  perform set_config('request.jwt.claim.sub', '', true);

  delete from public.cabin_air where window_start < clock_timestamp() - interval '24 hours';
end;
$$;
revoke all on function omni_private.demo_air_reading(text, timestamptz, int) from public, anon, authenticated;
revoke all on function omni_private.demo_air_tick(timestamptz) from public, anon, authenticated;

-- 6 hours of history, then every 5 minutes.
do $$
begin
  if not exists (select 1 from public.cabin_air) then
    for i in reverse 72..0 loop
      perform omni_private.demo_air_tick(clock_timestamp() - make_interval(mins => i * 5));
    end loop;
  end if;
end;
$$;

select cron.schedule('omni-demo-air', '*/5 * * * *', 'select omni_private.demo_air_tick()');

-- One finished procedure so the history isn't empty: SURGEON treated MS1 for
-- floating debris in the eye. Done as SURGEON, through the normal rules.
do $$
declare
  v_cmo_auth uuid := (select auth_user_id from public.crew_members where callsign = 'SURGEON');
  v_ms1 uuid := (select id from public.crew_members where callsign = 'MS1');
  v_run uuid;
begin
  if exists (select 1 from public.procedure_runs) then
    return;
  end if;
  perform set_config('request.jwt.claim.sub', v_cmo_auth::text, true);
  insert into public.procedure_runs (protocol, patient_crew_id) values ('eye_injury', v_ms1) returning id into v_run;
  insert into public.procedure_steps (run_id, step_no) select v_run, n from generate_series(1, 5) n;
  update public.procedure_runs
     set outcome = 'completed', notes = 'Metal flake from the ECLSS filter housing. Irrigated; vision 20/20 both eyes after. Recheck tomorrow.'
   where id = v_run;
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
