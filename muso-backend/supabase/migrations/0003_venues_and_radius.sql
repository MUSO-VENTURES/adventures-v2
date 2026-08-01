-- MUSO Adventures — real venue integration + playing-radius feature (v1.1)
-- Safe to run once after 0001_init.sql and 0002_seed.sql. Guards on name/title
-- so it's re-runnable without creating duplicates.

-- =========================================================
-- VENUE METADATA (rating/contact/source, for real-world venues)
-- =========================================================

alter table venues
  add column if not exists phone text,
  add column if not exists rating numeric(2,1) check (rating is null or (rating >= 0 and rating <= 5)),
  add column if not exists rating_count int,
  add column if not exists source_url text;

-- =========================================================
-- PLAYING RADIUS (chosen starting pin + radius, captured on the
-- discovery form). Defaults to a 25-mile radius centered on
-- Livermore, CA 94551 — the client should override start_lat/start_lng
-- with the player's chosen pin when it differs from the default.
-- =========================================================

alter table discovery_responses
  add column if not exists start_lat numeric(9,6),
  add column if not exists start_lng numeric(9,6),
  add column if not exists radius_miles int not null default 25 check (radius_miles > 0 and radius_miles <= 200);

-- Haversine great-circle distance in miles between two lat/lng points.
create or replace function haversine_miles(lat1 numeric, lng1 numeric, lat2 numeric, lng2 numeric)
returns numeric
language sql
immutable
as $func$
  select (3958.8 * acos(
    least(1.0, greatest(-1.0,
      cos(radians(lat1::float8)) * cos(radians(lat2::float8)) * cos(radians(lng2::float8) - radians(lng1::float8))
      + sin(radians(lat1::float8)) * sin(radians(lat2::float8))
    ))
  ))::numeric;
$func$;

-- Routes where every stop with a known venue falls within the given radius
-- of the chosen starting pin. Mystery stops with no venue assigned yet
-- (venue_id is null) never disqualify a route.
create or replace function routes_within_radius(p_start_lat numeric, p_start_lng numeric, p_radius_miles numeric)
returns setof routes
language sql
stable
as $func$
  select r.*
  from routes r
  where not exists (
    select 1
    from route_stops rs
    join venues v on v.id = rs.venue_id
    where rs.route_id = r.id
      and rs.venue_id is not null
      and v.lat is not null and v.lng is not null
      and haversine_miles(p_start_lat, p_start_lng, v.lat, v.lng) > p_radius_miles
  );
$func$;

-- =========================================================
-- REAL VENUES — Livermore, CA (verified via Honeycomb Cocktail
-- Lounge's own site and Da Boccery's listed address, ratings as of
-- this migration; refresh periodically since ratings drift over time)
-- =========================================================

do $$
declare
  v_honeycomb uuid;
  v_daboccery uuid;
  v_route uuid;
begin
  if not exists (select 1 from venues where name = 'Honeycomb Cocktail Lounge') then
    insert into venues (name, category, address, lat, lng, phone, rating, rating_count, source_url, partner_tier)
    values (
      'Honeycomb Cocktail Lounge', 'cocktail lounge / speakeasy',
      '2321 First St, Livermore, CA 94550', 37.682058, -121.768053,
      '925-447-1606', 4.5, 62, 'https://www.honeycomblounge.com/', 'basic'
    ) returning id into v_honeycomb;
  else
    select id into v_honeycomb from venues where name = 'Honeycomb Cocktail Lounge';
  end if;

  if not exists (select 1 from venues where name = 'Da Boccery') then
    insert into venues (name, category, address, lat, lng, rating, rating_count, source_url, partner_tier)
    values (
      'Da Boccery', 'axe throwing / entertainment',
      '175 E Vineyard Ave, Livermore, CA 94550', 37.651243, -121.803757,
      4.6, 284, 'https://daboccery.com/', 'basic'
    ) returning id into v_daboccery;
  else
    select id into v_daboccery from venues where name = 'Da Boccery';
  end if;

  -- No venue_contacts rows are created for these two real businesses —
  -- we don't have an authorized contact on file, so "players are heading
  -- your way" notifications correctly fall through to the existing
  -- 'skipped_no_contact' status until the venue opts in with real contact info.

  if not exists (select 1 from routes where title = 'Livermore Local') then
    insert into routes (twist_key, title, description)
    values ('adv-stakes', 'Livermore Local', 'Real Tri-Valley spots: throw axes at Da Boccery, then slip into the Honeycomb speakeasy.')
    returning id into v_route;

    insert into route_stops (route_id, venue_id, stop_order, name, description, emoji, is_mystery, game_prep_notes)
    values
      (v_route, v_daboccery, 1, 'Da Boccery', 'Axe throwing, bocce, and wood-fired pizza in Livermore.', '🪓', false,
        'Book the axe lane in advance; sessions run about an hour and include waivers + instruction.'),
      (v_route, v_honeycomb, 2, 'Unknown Location', 'A hidden speakeasy — password required at the door.', '🐝', true,
        'This is Honeycomb Cocktail Lounge. The password is posted on their Instagram pinned post every Tuesday — screenshot it before you go.');
  end if;
end $$;
