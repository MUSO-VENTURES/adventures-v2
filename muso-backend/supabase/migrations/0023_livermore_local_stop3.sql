-- MUSO Adventures — add a 3rd stop to the "Livermore Local" curated route
-- (id c26ae6ce-814e-41bc-b0b2-5e12576cd991), which only had 2 stops —
-- below the new 3-stop minimum for every adventure. Address/coordinates
-- confirmed via OpenStreetMap: 152 S Livermore Ave, Livermore, CA 94550.
--
-- partner_tier is set to 'premium' here on purpose — upsert_yelp_venues()
-- (0007_gamification.sql) explicitly excludes partner_tier from its
-- on-conflict update, specifically so a manually-set business relationship
-- like this one never gets reset back to 'basic' by a routine Yelp
-- refresh. That's also why yelp_id is set to Yelp's own business alias
-- for this exact location (from yelp.com/biz/peets-coffee-livermore-2) —
-- once a real-venue/wine-country search naturally discovers this same
-- business via the live Yelp API, it'll upsert into this same row
-- (matched by yelp_id) rather than creating a duplicate, and inherit the
-- premium tier. weightedRandomPick() in real-venue-adventure/index.ts
-- gives 'premium'/'sponsor' venues a 3x weighting boost, making this the
-- preferred coffee pick whenever a coffee-themed fork choice comes up
-- near Livermore. (If that alias turns out to be slightly off, the worst
-- case is a harmless duplicate row next time Yelp is searched here — not
-- a broken state, just worth a quick check later.)

with new_venue as (
  insert into venues (name, category, address, lat, lng, phone, yelp_id, partner_tier)
  values (
    'Peet''s Coffee',
    'coffee',
    '152 S Livermore Ave, Livermore, CA 94550',
    37.681844,
    -121.767858,
    '(925) 579-5011',
    'peets-coffee-livermore-2',
    'premium'
  )
  returning id
)
insert into route_stops (route_id, venue_id, stop_order, name, description, emoji, is_mystery)
select
  'c26ae6ce-814e-41bc-b0b2-5e12576cd991',
  new_venue.id,
  3,
  'Peet''s Coffee',
  'Wind down with a coffee at this Livermore favorite.',
  '☕',
  false
from new_venue;
