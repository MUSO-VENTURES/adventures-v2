-- MUSO Adventures — Leveling, Adventure Coins, Featured Venues (v7)
--
-- Backs three preview-page features:
--   1. Geolocation-based radius search, with a paid/earned unlock to go
--      beyond the free 25-mile default.
--   2. "Find Real Venues" itself gated behind Level 5 (xp >= 400) OR
--      spending Adventure Coins — free/anonymous visitors see a locked
--      teaser instead of full results.
--   3. Featured (paid-membership) venues get priority inclusion anywhere in
--      an assembled route ahead of non-paying venues, unless a featured
--      venue has requested a fixed stop slot (featured_position).
--
-- All of this requires real accounts, so this migration assumes Supabase
-- Auth is in use and profiles.id continues to reference auth.users(id) as
-- set up in 0001_init.sql.

-- ---------------------------------------------------------------
-- profiles: leveling + currency
-- ---------------------------------------------------------------

alter table profiles
  add column if not exists xp integer not null default 0,
  add column if not exists adventure_coins integer not null default 0,
  add column if not exists unlocked_radius_miles integer not null default 25,
  add column if not exists venues_search_unlocked boolean not null default false;

-- level is derived from xp rather than stored independently, so it can
-- never drift out of sync: 100 xp per level, starting at level 1.
alter table profiles
  drop column if exists level;
alter table profiles
  add column level integer generated always as (floor(xp / 100.0) + 1) stored;

alter table profiles
  drop constraint if exists profiles_xp_nonnegative;
alter table profiles
  add constraint profiles_xp_nonnegative check (xp >= 0);

alter table profiles
  drop constraint if exists profiles_coins_nonnegative;
alter table profiles
  add constraint profiles_coins_nonnegative check (adventure_coins >= 0);

alter table profiles
  drop constraint if exists profiles_radius_range;
alter table profiles
  add constraint profiles_radius_range check (unlocked_radius_miles between 25 and 500);

-- Players can still update their own display_name / avatar_color / phone via
-- the existing "user updates own profile" policy from 0001_init.sql, but
-- xp/coins/radius-unlock/search-unlock must only ever move through edge
-- functions running as the service role (real leveling, real purchases).
-- Revoking direct column UPDATE from the authenticated role is
-- defense-in-depth on top of never shipping client code that would do this
-- update — mirrors the belt-and-suspenders pattern already used for the
-- age gate (client check + server check + DB check).
revoke update (xp, adventure_coins, unlocked_radius_miles, venues_search_unlocked) on profiles from authenticated;

-- ---------------------------------------------------------------
-- venues: featured / sponsor placement
-- ---------------------------------------------------------------

-- partner_tier already exists ('basic' | 'premium' | 'sponsor') from
-- 0001_init.sql. 'premium' and 'sponsor' venues are "featured": the route
-- assembly logic gives them priority inclusion anywhere ahead of 'basic'
-- venues. featured_position additionally lets a featured venue lock in a
-- *specific* stop slot (1-indexed) instead of floating anywhere — e.g. a
-- sponsor who always wants to be the final "headliner" stop sets
-- featured_position = 3 for a 3-stop route. Null means "featured, no fixed
-- slot, just bumped to the front of the pool."
alter table venues
  add column if not exists featured_position integer;

alter table venues
  drop constraint if exists venues_featured_position_positive;
alter table venues
  add constraint venues_featured_position_positive check (featured_position is null or featured_position > 0);

alter table venues
  drop constraint if exists venues_featured_position_requires_tier;
alter table venues
  add constraint venues_featured_position_requires_tier check (
    featured_position is null or partner_tier in ('premium','sponsor')
  );

-- ---------------------------------------------------------------
-- coin ledger
-- ---------------------------------------------------------------

create table if not exists coin_transactions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  amount integer not null,              -- positive = credit (purchase/reward), negative = debit (spend)
  reason text not null check (reason in ('purchase','unlock_radius','unlock_venue_search','admin_grant','xp_reward')),
  stripe_payment_intent_id text,        -- set for 'purchase' rows, null otherwise
  created_at timestamptz not null default now()
);

create index if not exists idx_coin_transactions_profile on coin_transactions(profile_id, created_at desc);

alter table coin_transactions enable row level security;

drop policy if exists "user reads own coin transactions" on coin_transactions;
create policy "user reads own coin transactions" on coin_transactions for select using (auth.uid() = profile_id);

-- No insert/update/delete policies for authenticated: every ledger write
-- goes through an edge function using the service role key (bypasses RLS
-- entirely), so a balance can never be forged from the client.

-- Stripe can retry a webhook delivery; this makes crediting the same
-- payment twice impossible at the DB layer (credit_coins() below relies on
-- this constraint failing on a duplicate stripe_payment_intent_id).
create unique index if not exists idx_coin_transactions_stripe_intent
  on coin_transactions(stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- ---------------------------------------------------------------
-- atomic coin ledger operations (called from edge functions only,
-- via the service role — never exposed directly to the client)
-- ---------------------------------------------------------------

-- Credits coins (a real Stripe purchase, or a future reward). Runs the
-- balance update and the ledger insert in one statement each inside a
-- single function invocation, so there's no window where a balance change
-- exists without its matching ledger row.
create or replace function credit_coins(
  p_profile_id uuid,
  p_amount integer,
  p_reason text,
  p_stripe_payment_intent_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $func$
begin
  if p_amount <= 0 then
    raise exception 'credit_coins amount must be positive';
  end if;

  update profiles set adventure_coins = adventure_coins + p_amount where id = p_profile_id;

  insert into coin_transactions (profile_id, amount, reason, stripe_payment_intent_id)
  values (p_profile_id, p_amount, p_reason, p_stripe_payment_intent_id);
end;
$func$;

-- Debits coins for an unlock purchase. The UPDATE's WHERE clause re-checks
-- the balance at write time (not just read time), so two concurrent unlock
-- requests can't both succeed off a stale balance read — only one can win.
-- Returns false (and writes nothing) if the balance is insufficient.
create or replace function debit_coins(
  p_profile_id uuid,
  p_amount integer,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $func$
declare
  affected integer;
begin
  if p_amount <= 0 then
    raise exception 'debit_coins amount must be positive';
  end if;

  update profiles set adventure_coins = adventure_coins - p_amount
  where id = p_profile_id and adventure_coins >= p_amount;

  get diagnostics affected = row_count;
  if affected = 0 then
    return false;
  end if;

  insert into coin_transactions (profile_id, amount, reason)
  values (p_profile_id, -p_amount, p_reason);

  return true;
end;
$func$;

-- ---------------------------------------------------------------
-- venue upsert that never clobbers manually-curated partner fields
-- ---------------------------------------------------------------

-- Used by venues-search on every live Yelp lookup to refresh cached venue
-- data (rating, address, photo, ...). partner_tier and featured_position
-- are deliberately excluded from the UPDATE SET list below — those are
-- business relationships set by MUSO staff, not something an automated
-- Yelp refresh should ever be able to reset back to 'basic'.
create or replace function upsert_yelp_venues(rows jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $func$
begin
  insert into venues (yelp_id, name, category, address, lat, lng, phone, rating, rating_count, source_url, image_url, partner_tier)
  select
    r->>'yelp_id',
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
    'basic'
  from jsonb_array_elements(rows) as r
  on conflict (yelp_id) do update set
    name = excluded.name,
    category = excluded.category,
    address = excluded.address,
    lat = excluded.lat,
    lng = excluded.lng,
    phone = excluded.phone,
    rating = excluded.rating,
    rating_count = excluded.rating_count,
    source_url = excluded.source_url,
    image_url = excluded.image_url;
end;
$func$;
