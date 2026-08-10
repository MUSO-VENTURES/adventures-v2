-- MUSO Adventures — venue hours (v24)
--
-- Backs the "never send players to a closed venue" gating: real-venue and
-- Wine Country adventures should never offer a fork choice that's closed
-- or closing within 30 minutes. Hours come from Yelp's Business Details
-- endpoint (the search endpoint used elsewhere in this schema doesn't
-- return hours at all), cached here with a 24h TTL so repeated searches
-- near the same venue across many players/days don't re-fetch on every
-- request — see getVenueHours() in real-venue-adventure/index.ts.

alter table venues
  add column if not exists hours jsonb,
  add column if not exists hours_fetched_at timestamptz;

-- Extend nearby_candidate_venues() with yelp_id (needed to call Yelp's
-- Business Details endpoint for a candidate) and the new hours cache
-- columns, same "drop then recreate" pattern 0021_venue_reviews.sql used
-- to add muso_rating/muso_rating_count — Postgres won't let CREATE OR
-- REPLACE change a RETURNS TABLE column list.
drop function if exists nearby_candidate_venues(numeric, numeric, numeric, text[]);
create or replace function nearby_candidate_venues(
  p_lat numeric,
  p_lng numeric,
  p_radius_miles numeric,
  p_yelp_ids text[]
)
returns table (
  id uuid,
  name text,
  category text,
  address text,
  lat numeric,
  lng numeric,
  rating numeric,
  image_url text,
  partner_tier text,
  distance_miles numeric,
  muso_rating numeric,
  muso_rating_count int,
  yelp_id text,
  hours jsonb,
  hours_fetched_at timestamptz
)
language sql
stable
as $func$
  select
    v.id, v.name, v.category, v.address, v.lat, v.lng,
    v.rating, v.image_url, v.partner_tier,
    haversine_miles(p_lat, p_lng, v.lat, v.lng) as distance_miles,
    v.muso_rating, v.muso_rating_count,
    v.yelp_id, v.hours, v.hours_fetched_at
  from venues v
  where v.yelp_id = any(p_yelp_ids)
    and v.lat is not null and v.lng is not null
    and haversine_miles(p_lat, p_lng, v.lat, v.lng) <= p_radius_miles
  order by distance_miles asc;
$func$;
