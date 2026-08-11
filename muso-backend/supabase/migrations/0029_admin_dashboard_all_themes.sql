-- Admin dashboard's adventure_modes breakdown hardcoded a single
-- wine_country special case, so every other themed real-venue adventure
-- (dog_friendly, outdoor, oddities, foodie_tour, and any future theme)
-- silently collapsed into the generic 'fork_in_the_road' bucket. Swapping
-- in coalesce(r.venue_theme, 'fork_in_the_road') means a new theme shows
-- its own bucket automatically, no dashboard migration needed each time
-- one's added — same "add it to the registry, not to special-case
-- branches" spirit as the real-venue-adventure edge function's own
-- THEME_REGISTRY refactor.
--
-- create or replace function, so this is the whole function body again
-- (Postgres has no ALTER FUNCTION for changing a SQL function's body) —
-- copied verbatim from 0025_admin_dashboard.sql with only the
-- adventure_modes CASE statement changed.

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
              else coalesce(r.venue_theme, 'fork_in_the_road')
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
