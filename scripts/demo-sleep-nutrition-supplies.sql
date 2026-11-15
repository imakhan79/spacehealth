-- Ground demo only: sleep, nutrition and life-support data for the public crew
-- demo. NEVER apply on flight hardware. Needs migration
-- 20261115000600_sleep_nutrition_supplies.sql and the earlier demo scripts.
--
-- Seed (once): 7 nights of sleep, 30 days of supply readings.
-- Live (every 30 min, pg_cron):
--   * after 06:45Z, last night's sleep for each crew member, recorded as the
--     wearable gateway (as that account, through the normal rules);
--   * SURGEON and MS1 log meals and water at mealtimes, as themselves
--     (MS1 drinks too little, so the "behind pace" flag shows);
--   * every 6 h a supply reading, as the tank sensors (gateway).
--
--   Stop:   select cron.unschedule('omni-demo-life');

-- --- seed -------------------------------------------------------------------------

do $$
declare
  v_today timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
begin
  if not exists (select 1 from public.sleep_periods) then
    alter table public.sleep_periods disable trigger user;
    insert into public.sleep_periods (crew_member_id, started_at, ended_at, quality, source)
    select cm.id,
           v_today - make_interval(days => d) - interval '90 minutes' + make_interval(mins => (d * 7) % 25),
           v_today - make_interval(days => d) + make_interval(hours => 6, mins => 30)
             - case cm.callsign when 'SURGEON' then case when d <= 3 then interval '150 minutes' else interval '30 minutes' end
                                when 'MS1' then interval '60 minutes'
                                else interval '0 minutes' end,
           case cm.callsign when 'SURGEON' then case when d <= 3 then 2 else 4 end when 'MS1' then 3 else 4 end,
           'wearable'
      from public.crew_members cm
     cross join generate_series(1, 7) d
     where cm.callsign in ('CDR', 'SURGEON', 'MS1');
    alter table public.sleep_periods enable trigger user;
  end if;

  if not exists (select 1 from public.consumable_readings) then
    alter table public.consumable_readings disable trigger user;
    insert into public.consumable_readings (resource, quantity, measured_at)
    select r.resource::public.consumable,
           greatest(0, case r.resource
             -- start = stock 30 days ago; falls by per_day (i counts 6-hour steps).
             when 'co2_cartridges' then floor(r.start - r.per_day * i / 4.0)
             else round((r.start - r.per_day * i / 4.0 + (random() - 0.5) * r.per_day * 0.2)::numeric, 1)
           end),
           v_today - interval '30 days' + make_interval(hours => i * 6)
      from (values ('oxygen', 312.0, 2.4), ('water', 1890.0, 9.2), ('food', 600.0, 3.0), ('co2_cartridges', 100.0, 1.0)) r(resource, start, per_day)
     cross join generate_series(0, 120) i
     where v_today - interval '30 days' + make_interval(hours => i * 6) <= now();
    alter table public.consumable_readings enable trigger user;
  end if;
end;
$$;

-- --- live -------------------------------------------------------------------------

create or replace function omni_private.demo_life_tick()
returns void
language plpgsql
set search_path = ''
as $$
declare
  v_now   timestamptz := clock_timestamp();
  v_today timestamptz := date_trunc('day', v_now at time zone 'utc') at time zone 'utc';
  v_min   int := extract(hour from v_now at time zone 'utc')::int * 60 + extract(minute from v_now at time zone 'utc')::int;
  v_gw    uuid := (select auth_user_id from public.crew_members where role = 'sensor_gateway' limit 1);
  c record;
  r record;
begin
  -- Last night's sleep, detected by the wearables (gateway), once per morning.
  if v_min >= 6 * 60 + 45 and v_gw is not null then
    perform set_config('request.jwt.claim.sub', v_gw::text, true);
    insert into public.sleep_periods (crew_member_id, started_at, ended_at, quality, source)
    select cm.id,
           v_today - interval '90 minutes' + make_interval(mins => (extract(doy from v_now)::int * 7) % 25),
           v_today + interval '6 hours 30 minutes'
             - case cm.callsign when 'SURGEON' then interval '150 minutes' when 'MS1' then interval '60 minutes' else interval '0 minutes' end,
           case cm.callsign when 'SURGEON' then 2 when 'MS1' then 3 else 4 end,
           'wearable'
      from public.crew_members cm
     where cm.callsign in ('CDR', 'SURGEON', 'MS1')
       and not exists (select 1 from public.sleep_periods s where s.crew_member_id = cm.id and s.ended_at > v_today);
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  -- Meals at 07:30, 12:30, 18:30 and water through the day, as SURGEON and MS1.
  for c in select cm.callsign, cm.auth_user_id, cm.id from public.crew_members cm where cm.callsign in ('SURGEON', 'MS1') loop
    perform set_config('request.jwt.claim.sub', c.auth_user_id::text, true);
    for r in
      select * from (values
        (7 * 60 + 30, 'meal', 'Oatmeal with raisins', 310, 9, 180, 0, 150),
        (7 * 60 + 35, 'meal', 'Milk drink (fortified)', 160, 9, 350, 120, 230),
        (12 * 60 + 30, 'meal', 'Teriyaki chicken & rice', 520, 38, 60, 0, 100),
        (18 * 60 + 30, 'meal', 'Salmon with vegetables', 420, 34, 120, 450, 90)
      ) m(at_min, kind, label, kcal, protein, calcium, vit_d, water)
      where m.at_min <= v_min
    loop
      insert into public.intake_logs (kind, label, kcal, protein_g, calcium_mg, vitamin_d_iu, water_ml, logged_at)
      select r.kind::public.intake_kind, r.label, r.kcal, r.protein, r.calcium, r.vit_d, r.water, v_today + make_interval(mins => r.at_min)
       where not exists (select 1 from public.intake_logs l where l.crew_member_id = c.id and l.label = r.label and l.logged_at >= v_today);
    end loop;
    -- Water: SURGEON every 2 h from 08:00, MS1 only every 4 h.
    insert into public.intake_logs (kind, label, water_ml, logged_at)
    select 'water', 'Water 500 ml', 500, v_today + make_interval(hours => h)
      from generate_series(8, 22, case c.callsign when 'SURGEON' then 2 else 4 end) h
     where h * 60 <= v_min
       and not exists (select 1 from public.intake_logs l where l.crew_member_id = c.id and l.kind = 'water' and l.logged_at = v_today + make_interval(hours => h));
  end loop;
  perform set_config('request.jwt.claim.sub', '', true);

  -- Supplies every 6 h, continuing each resource's trend from its last reading.
  if v_gw is not null and extract(hour from v_now at time zone 'utc')::int % 6 = 0 and extract(minute from v_now)::int < 30 then
    perform set_config('request.jwt.claim.sub', v_gw::text, true);
    insert into public.consumable_readings (resource, quantity, measured_at)
    select x.resource,
           -- Cartridges are whole units: one swapped out each day at 06:00.
           greatest(0, case when x.resource = 'co2_cartridges' then x.q - case when extract(hour from v_now at time zone 'utc')::int = 6 then 1 else 0 end
                            else round((x.q - x.per_day / 4 + (random() - 0.5) * x.per_day * 0.05)::numeric, 1) end),
           date_trunc('hour', v_now)
      from (
        select distinct on (cr.resource) cr.resource, cr.quantity as q,
               case cr.resource when 'oxygen' then 2.4 when 'water' then 9.2 when 'food' then 3.0 else 1.0 end as per_day
          from public.consumable_readings cr
         order by cr.resource, cr.measured_at desc
      ) x
    on conflict (resource, measured_at) do nothing;
    perform set_config('request.jwt.claim.sub', '', true);
  end if;

  delete from public.intake_logs where logged_at < v_now - interval '14 days';
  delete from public.sleep_periods where ended_at < v_now - interval '30 days';
  delete from public.consumable_readings where measured_at < v_now - interval '60 days';
end;
$$;
revoke all on function omni_private.demo_life_tick() from public, anon, authenticated;

select omni_private.demo_life_tick();
select cron.schedule('omni-demo-life', '*/30 * * * *', 'select omni_private.demo_life_tick()');
