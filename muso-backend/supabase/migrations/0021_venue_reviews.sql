-- MUSO Adventures — venue ratings & reviews (v21)
--
-- Players can now leave a 1-10 MUSO rating + optional written review after
-- checking in at a stop. This is deliberately separate from venues.rating/
-- rating_count (0003_venues_and_radius.sql), which is Yelp-sourced data
-- that gets overwritten wholesale on every Yelp upsert
-- (0007_gamification.sql's upsert_yelp_venues) — MUSO's own aggregate
-- needs its own columns so a Yelp refresh never clobbers player reviews.

alter table venues
  add column if not exists muso_rating numeric(3,1),
  add column if not exists muso_rating_count int not null default 0;

-- One review per check-in (not per venue) — a player can revisit the same
-- venue across different adventures and leave a fresh review each time;
-- re-submitting for the SAME check-in edits rather than duplicates.
create table if not exists venue_reviews (
  id uuid primary key default gen_random_uuid(),
  check_in_id uuid not null unique references check_ins(id) on delete cascade,
  venue_id uuid not null references venues(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  rating smallint not null check (rating between 1 and 10),
  review_text text,
  created_at timestamptz not null default now()
);

create index if not exists idx_venue_reviews_venue on venue_reviews(venue_id);
create index if not exists idx_venue_reviews_profile on venue_reviews(profile_id);

alter table venue_reviews enable row level security;

-- Reviews are meant to be visible to other players (e.g. on fork-choice
-- cards), same "readable by any signed-in player" spirit as venues itself.
create policy "reviews readable by authenticated" on venue_reviews for select using (
  auth.role() = 'authenticated'
);

-- Mirrors the check_ins "members create own check-ins" policy shape
-- (0001_init.sql) — a player may only review a check-in that is both
-- theirs and actually their own check-in row.
create policy "players review their own check-ins" on venue_reviews for insert with check (
  profile_id = auth.uid()
  and exists (
    select 1 from check_ins c where c.id = venue_reviews.check_in_id and c.checked_in_by = auth.uid()
  )
);
create policy "players edit their own reviews" on venue_reviews for update using (
  profile_id = auth.uid()
) with check (
  profile_id = auth.uid()
);

-- Recomputes the MUSO aggregate for one venue from venue_reviews. Runs via
-- trigger (below) rather than being called explicitly from edge-function
-- code like credit_coins/award_xp — an aggregate that's this cheap to
-- derive is safer kept correct at the database layer regardless of which
-- code path writes a review.
create or replace function recompute_venue_muso_rating(p_venue_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $func$
begin
  update venues v set
    muso_rating = (select round(avg(rating)::numeric, 1) from venue_reviews where venue_id = p_venue_id),
    muso_rating_count = (select count(*) from venue_reviews where venue_id = p_venue_id)
  where v.id = p_venue_id;
end;
$func$;

create or replace function venue_reviews_recompute_trigger()
returns trigger
language plpgsql
security definer
set search_path = public
as $func$
begin
  if tg_op = 'DELETE' then
    perform recompute_venue_muso_rating(old.venue_id);
    return old;
  end if;
  perform recompute_venue_muso_rating(new.venue_id);
  if tg_op = 'UPDATE' and old.venue_id is distinct from new.venue_id then
    perform recompute_venue_muso_rating(old.venue_id);
  end if;
  return new;
end;
$func$;

drop trigger if exists venue_reviews_recompute on venue_reviews;
create trigger venue_reviews_recompute
  after insert or update or delete on venue_reviews
  for each row execute function venue_reviews_recompute_trigger();

-- Extend nearby_candidate_venues() (0016_real_venue_adventures.sql) with
-- the new muso_rating/muso_rating_count columns so fork-choice candidates
-- carry MUSO's own aggregate alongside the existing Yelp rating. Postgres
-- won't let CREATE OR REPLACE change a RETURNS TABLE column list, so this
-- drops and recreates it (same pattern 0018_adventure_attribution.sql uses
-- for credit_coins/award_badge).
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
  muso_rating_count int
)
language sql
stable
as $func$
  select
    v.id, v.name, v.category, v.address, v.lat, v.lng,
    v.rating, v.image_url, v.partner_tier,
    haversine_miles(p_lat, p_lng, v.lat, v.lng) as distance_miles,
    v.muso_rating, v.muso_rating_count
  from venues v
  where v.yelp_id = any(p_yelp_ids)
    and v.lat is not null and v.lng is not null
    and haversine_miles(p_lat, p_lng, v.lat, v.lng) <= p_radius_miles
  order by distance_miles asc;
$func$;
