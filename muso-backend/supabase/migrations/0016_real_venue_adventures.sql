-- MUSO Adventures — Real-venue adventure mode (v16)
--
-- Backs a second way to play, alongside the existing curator-authored
-- route/route_stops system: a party's stops can now be assembled on the
-- fly from live, real, nearby venues (matched to the player's saved
-- preferences) instead of picking a pre-written route. checkin/route-detail
-- don't care who authored a route (verified by reading checkin/index.ts) —
-- an ad-hoc route satisfies the exact same shape, so the whole existing
-- check-in/XP/badge/photo-booth loop keeps working completely unmodified.
--
-- owner_party_id is the only new concept: null means "curated, visible to
-- everyone" (today's behavior, unchanged); non-null means "ad-hoc, visible
-- only to that party." routes/route_stops previously had no writable
-- policy for the authenticated role at all — writes only ever happened via
-- seed data or (going forward) the new real-venue-adventure edge function
-- running as service role, so no INSERT policy is added here either.

alter table routes
  add column if not exists owner_party_id uuid references parties(id) on delete cascade;

drop policy if exists "content readable by authenticated" on routes;
create policy "curated or own party's routes readable" on routes for select using (
  owner_party_id is null or is_party_member(owner_party_id)
);

drop policy if exists "content readable by authenticated" on route_stops;
create policy "curated or own party's route_stops readable" on route_stops for select using (
  exists (
    select 1 from routes
    where routes.id = route_stops.route_id
      and (routes.owner_party_id is null or is_party_member(routes.owner_party_id))
  )
);

-- Lets the client (and future queries) tell a real-venue adventure apart
-- from a curated one without inferring it from routes.owner_party_id —
-- e.g. to show/hide the "Chance Your Luck" reroll UI.
alter table adventures
  add column if not exists mode text not null default 'curated' check (mode in ('curated','real_venue'));

-- How many times this stop's venue has been re-rolled — first 3 are free,
-- the 4th+ costs Adventure Coins (see real-venue-adventure edge function).
alter table route_stops
  add column if not exists reroll_count integer not null default 0 check (reroll_count >= 0);

-- The full distance-sorted candidate list real-venue-adventure's `init`/
-- `advance` fetched from Yelp for this stop, cached at the moment the stop
-- was revealed so `reroll` can pick a different one instantly without
-- another Yelp round-trip (and so a reroll never returns a venue from a
-- totally different neighborhood than the one originally searched). Null
-- for curated-route stops and for real-venue stops that haven't been
-- revealed yet (is_mystery = true, waiting on a future `advance` call).
alter table route_stops
  add column if not exists candidate_pool jsonb;

-- routes.twist_key is a required FK — ad-hoc real-venue routes need *a*
-- twist to point to even though they're not really "twisted" in the
-- curated-content sense. One fixed mood/twist pair, reused by every
-- real-venue adventure.
insert into moods (key, label, emoji) values
  ('real', 'Real Venues', '📍')
on conflict (key) do nothing;

insert into twists (key, mood_key, label, emoji) values
  ('real-auto', 'real', 'Auto-Picked', '🎯')
on conflict (key) do nothing;

-- Distance-ordered, tier-annotated candidate list for the real-venue
-- adventure edge function's init/reroll/advance actions. p_yelp_ids scopes
-- the search to venues just upserted from a live Yelp call (see
-- upsert_yelp_venues in 0007_gamification.sql) so this never accidentally
-- returns stale/unrelated venues from an earlier, different search.
-- Reuses haversine_miles() from 0003_venues_and_radius.sql as the distance
-- primitive — no PostGIS/earthdistance extension involved, consistent with
-- the rest of this schema.
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
  distance_miles numeric
)
language sql
stable
as $func$
  select
    v.id, v.name, v.category, v.address, v.lat, v.lng,
    v.rating, v.image_url, v.partner_tier,
    haversine_miles(p_lat, p_lng, v.lat, v.lng) as distance_miles
  from venues v
  where v.yelp_id = any(p_yelp_ids)
    and v.lat is not null and v.lng is not null
    and haversine_miles(p_lat, p_lng, v.lat, v.lng) <= p_radius_miles
  order by distance_miles asc;
$func$;
