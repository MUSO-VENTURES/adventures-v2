-- MUSO Adventures — admin analytics dashboard (v25)
--
-- Schema support for the internal "brains of the business" dashboard:
-- an admin access flag, a persisted record of which fork-choice theme a
-- player actually picked (today that info only lives transiently inside
-- offered_choices, which gets cleared once a pick is made), and a new
-- impressions/conversions log per venue — the actual new instrumentation
-- this feature needs, since it's the foundation any future partner-ROI
-- report ("how many people saw us, picked us, rated us") would draw on.

alter table profiles
  add column if not exists is_admin boolean not null default false;

-- Bootstrap Shane's own account. Safe to re-run — no-op if already admin.
update profiles set is_admin = true
where id = (select id from auth.users where email = 'smusseau@gmail.com');

alter table route_stops
  add column if not exists chosen_theme_key text;

create table if not exists venue_offer_events (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  route_stop_id uuid not null references route_stops(id) on delete cascade,
  adventure_id uuid references adventures(id) on delete set null,
  theme_key text,
  offered_at timestamptz not null default now(),
  chosen boolean not null default false,
  chosen_at timestamptz
);

create index if not exists idx_venue_offer_events_venue on venue_offer_events(venue_id);
create index if not exists idx_venue_offer_events_stop on venue_offer_events(route_stop_id);

-- Internal-only table — no player should ever read this directly. RLS
-- enabled with zero policies denies all access to anon/authenticated; the
-- service-role client used by real-venue-adventure/index.ts and the new
-- admin-dashboard-data function bypasses RLS entirely, same as every
-- other internal-only table in this schema (venue_notifications, etc.).
alter table venue_offer_events enable row level security;

-- ---------------------------------------------------------------
-- admin_dashboard_snapshot() — one call, one jsonb payload covering every
-- section of the dashboard. Locked down to service_role only (see grants
-- at the bottom) so a regular authenticated user can't call this RPC
-- directly and read aggregate business data by working around the admin
-- check that lives in the edge function, not here.
-- ---------------------------------------------------------------

create or replace function admin_dashboard_snapshot()
returns jsonb
language sql
stable
security definer
set search_path = public
as $func$
  select jsonb_build_object(
    'overview', (
      select jsonb_build_object(
        'total_players', (select count(*) from profiles),
        'total_adventures', (select count(*) from adventures),
        'completed_adventures', (select count(*) from adventures where status = 'completed'),
        'completion_rate', (
          select case when count(*) = 0 then 0
            else round((count(*) filter (where status = 'completed'))::numeric / count(*), 3) end
          from adventures
        )
      )
    ),
    'demographics', jsonb_build_object(
      'age_buckets', (
        select coalesce(jsonb_agg(jsonb_build_object('bucket', bucket, 'count', cnt) order by bucket), '[]'::jsonb)
        from (
          select
            case
              when birth_date is null then 'unknown'
              when date_part('year', age(birth_date)) < 18 then 'under_18'
              when date_part('year', age(birth_date)) between 18 and 24 then '18_24'
              when date_part('year', age(birth_date)) between 25 and 34 then '25_34'
              when date_part('year', age(birth_date)) between 35 and 44 then '35_44'
              when date_part('year', age(birth_date)) between 45 and 54 then '45_54'
              else '55_plus'
            end as bucket,
            count(*) as cnt
          from profiles
          group by 1
        ) s
      ),
      -- Best-effort city, not a real geocoded region — parsed from
      -- venues.address (typically "street, city, state zip"). Good enough
      -- for a "where are people playing" signal, not survey-grade data.
      'regions', (
        select coalesce(jsonb_agg(jsonb_build_object('city', city, 'count', cnt) order by cnt desc), '[]'::jsonb)
        from (
          select coalesce(nullif(trim(split_part(v.address, ',', 2)), ''), 'Unknown') as city, count(*) as cnt
          from check_ins ci
          join route_stops rs on rs.id = ci.route_stop_id
          join venues v on v.id = rs.venue_id
          group by 1
          order by cnt desc
          limit 20
        ) s
      )
    ),
    'gameplay', jsonb_build_object(
      'categories', (
        select coalesce(jsonb_agg(jsonb_build_object('theme', chosen_theme_key, 'count', cnt) order by cnt desc), '[]'::jsonb)
        from (
          select chosen_theme_key, count(*) as cnt
          from route_stops
          where chosen_theme_key is not null
          group by 1
        ) s
      ),
      'adventure_modes', (
        select coalesce(jsonb_agg(jsonb_build_object('mode', mode_label, 'count', cnt) order by cnt desc), '[]'::jsonb)
        from (
          select
            case
              when a.mode = 'curated' then 'curated'
              when r.venue_theme = 'wine_country' then 'wine_country'
              else 'fork_in_the_road'
            end as mode_label,
            count(*) as cnt
          from adventures a
          join routes r on r.id = a.route_id
          group by 1
        ) s
      ),
      'hours_of_day', (
        select coalesce(jsonb_agg(jsonb_build_object('hour', hr, 'count', cnt) order by hr), '[]'::jsonb)
        from (
          select extract(hour from ci.checked_in_at at time zone 'America/Los_Angeles')::int as hr, count(*) as cnt
          from check_ins ci
          group by 1
        ) s
      ),
      'reroll_usage', (
        select jsonb_build_object(
          'total_rerolls', coalesce(sum(reroll_count), 0),
          'avg_rerolls_per_stop', coalesce(round(avg(reroll_count), 2), 0)
        )
        from route_stops
        where venue_id is not null
      )
    ),
    'rankings', jsonb_build_object(
      -- Display name + XP/level only — no email or other PII in a
      -- dashboard payload that isn't itself individually access-logged.
      'top_players', (
        select coalesce(jsonb_agg(jsonb_build_object('display_name', display_name, 'xp', xp, 'level', level) order by xp desc), '[]'::jsonb)
        from (select display_name, xp, level from profiles order by xp desc limit 20) s
      )
    ),
    'venue_performance', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'venue_name', venue_name, 'offered_count', offered_count, 'chosen_count', chosen_count,
        'conversion_rate', conversion_rate, 'muso_rating', muso_rating, 'muso_rating_count', muso_rating_count
      ) order by offered_count desc), '[]'::jsonb)
      from (
        select v.name as venue_name, count(voe.id) as offered_count,
          count(*) filter (where voe.chosen) as chosen_count,
          round((count(*) filter (where voe.chosen))::numeric / nullif(count(voe.id), 0), 3) as conversion_rate,
          v.muso_rating, v.muso_rating_count
        from venue_offer_events voe
        join venues v on v.id = voe.venue_id
        group by v.id, v.name, v.muso_rating, v.muso_rating_count
        order by offered_count desc
        limit 20
      ) s
    ),
    'monetization', jsonb_build_object(
      'by_reason', (
        select coalesce(jsonb_agg(jsonb_build_object('reason', reason, 'total_amount', total_amount, 'transaction_count', txn_count) order by reason), '[]'::jsonb)
        from (
          select reason, sum(amount) as total_amount, count(*) as txn_count
          from coin_transactions
          group by 1
        ) s
      ),
      -- Legitimately null/zero until real coin purchasing exists — the
      -- dashboard renders this as "no data yet," not an error.
      'avg_purchase_amount', (
        select round(avg(amount), 2) from coin_transactions where reason = 'purchase' and amount > 0
      ),
      'total_purchase_revenue_coins', (
        select coalesce(sum(amount), 0) from coin_transactions where reason = 'purchase' and amount > 0
      )
    )
  );
$func$;

revoke execute on function admin_dashboard_snapshot() from public, anon, authenticated;
grant execute on function admin_dashboard_snapshot() to service_role;
