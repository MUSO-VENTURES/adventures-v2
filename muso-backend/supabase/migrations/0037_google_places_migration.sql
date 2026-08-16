-- MUSO Adventures — migrate venue data provider from Yelp to Google Places (v37)
--
-- Yelp's free trial expired and the $229/mo plan wasn't affordable, so
-- real-venue-adventure/index.ts and venues-search/index.ts now call Google
-- Places API (New) instead. This migration adds the parallel identity
-- column/RPCs Google-Places-sourced venues need, without touching the
-- existing yelp_id column or any historically-seeded venue rows (the
-- Livermore Peet's Coffee seed in 0023, the two hand-seeded venues in
-- 0003) — those keep working exactly as before, they just won't get
-- future Yelp refreshes (upsert_yelp_venues is left in place, unused).
--
-- image_url is included as `if not exists` defensively — it's read/written
-- by upsert_yelp_venues (0007) and nearby_candidate_venues (0016 onward)
-- but no migration in this directory actually adds the column, meaning it
-- was added out-of-band via the Supabase dashboard at some point. Safe to
-- repeat here since it's idempotent.

alter table venues
  add column if not exists google_place_id text unique,
  add column if not exists image_url text,
  add column if not exists hours jsonb,
  add column if not exists hours_fetched_at timestamptz;

-- Google Places (New) equivalent of upsert_yelp_venues (0007_gamification.sql)
-- — same "never clobber manually-curated partner fields" shape, conflict
-- target is google_place_id instead of yelp_id. Also writes hours/
-- hours_fetched_at write-through on every call (stamped with now() here,
-- not passed from the caller) — Google's Nearby Search (New) returns
-- opening hours in the same call as everything else, unlike Yelp's search
-- endpoint, so there's no separate lazy Business-Details-equivalent fetch
-- needed anymore (see real-venue-adventure/index.ts's removed
-- getVenueHours()). A place with no hours in the response gets `hours =
-- null`, same "unknown, assume open" fallback isOpenOrClosingSoon() has
-- always had.
create or replace function upsert_places_venues(rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $func$
begin
  insert into venues (google_place_id, name, category, address, lat, lng, phone, rating, rating_count, source_url, image_url, hours, hours_fetched_at, partner_tier)
  select
    r->>'google_place_id',
    r->>'name',
    r->>'category',
    r->>'address',
    (r->>'lat')::numeric,
    (r->>'lng')::numeric,
    r->>'phone',
    (r->>'rating')::numeric,
    (r->>'rating_count')::int,
    r->>'source_url',
    r->>'image_url',
    r->'hours',
    now(),
    'basic'
  from jsonb_array_elements(rows) as r
  on conflict (google_place_id) do update set
    name = excluded.name,
    category = excluded.category,
    address = excluded.address,
    lat = excluded.lat,
    lng = excluded.lng,
    phone = excluded.phone,
    rating = excluded.rating,
    rating_count = excluded.rating_count,
    source_url = excluded.source_url,
    image_url = excluded.image_url,
    hours = excluded.hours,
    hours_fetched_at = excluded.hours_fetched_at;
end;
$func$;

-- Google Places (New) equivalent of nearby_candidate_venues (last redefined
-- in 0024_venue_hours.sql) — same drop+recreate pattern (Postgres won't
-- let CREATE OR REPLACE change a RETURNS TABLE column list), scoped by
-- google_place_id instead of yelp_id. yelp_id is kept as an output column
-- for backward compat (nothing in the new code reads it, but it costs
-- nothing to leave it there for anything still touching this function's
-- old shape).
drop function if exists nearby_candidate_venues(numeric, numeric, numeric, text[]);
create or replace function nearby_candidate_venues(
  p_lat numeric,
  p_lng numeric,
  p_radius_miles numeric,
  p_google_place_ids text[]
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
  google_place_id text,
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
    v.yelp_id, v.google_place_id, v.hours, v.hours_fetched_at
  from venues v
  where v.google_place_id = any(p_google_place_ids)
    and v.lat is not null and v.lng is not null
    and haversine_miles(p_lat, p_lng, v.lat, v.lng) <= p_radius_miles
  order by distance_miles asc;
$func$;
