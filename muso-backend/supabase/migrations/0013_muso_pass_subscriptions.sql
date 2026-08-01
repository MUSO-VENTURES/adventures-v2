-- MUSO Adventures — MUSO Pass monthly subscriptions (v13)
--
-- Two recurring Stripe subscription tiers, sold from /shop/:
--   MUSO Pass      ($7.99/mo)  — 750 coins/mo, 50mi radius auto-unlocked,
--                                 3 reroute tokens/mo, subscriber badge,
--                                 1 visual theme unlocked.
--   MUSO Pass+     ($14.99/mo) — everything in Pass, plus 1,800 coins/mo,
--                                 all 5 stops + real venue search
--                                 auto-unlocked, access to the 100mi
--                                 "exclusive" radius tier, 1 free
--                                 real-world reward redemption/mo.
--
-- Design principle, mirrors every other unlock in this schema: permanent
-- unlocks (radius up to 50mi, extra stops, venue search) are things coins
-- or leveling up can already buy outright, so subscribing just raises them
-- the same permanent way — cancelling later never takes them back. The
-- 100mi exclusive tier is different: it's explicitly marketed as NOT
-- purchasable with coins (see 0012_radius_tiers.sql), so it must stay
-- strictly tied to an *active* Pass+ subscription. That means it's never
-- written to unlocked_radius_miles here — venues-search checks
-- subscription_tier/subscription_status live, at request time, instead.
--
-- Recurring-only entitlements (the monthly coin drop, reroute tokens, the
-- free reward redemption) genuinely lapse if the subscription isn't
-- renewed — reroute_tokens_remaining/reward_redemptions_remaining get
-- zeroed on cancellation via deactivate_subscription() below.
--
-- Theme unlocking on subscribe is intentionally NOT handled here — that
-- goes through the existing unlock_theme() RPC (0008_themes.sql) from the
-- subscribe edge function itself, since which theme to grant is a client
-- choice, not something this migration should hardcode.

-- ---------------------------------------------------------------
-- profiles: subscription state
-- ---------------------------------------------------------------

alter table profiles
  add column if not exists subscription_tier text not null default 'none',
  add column if not exists subscription_status text not null default 'inactive',
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_current_period_end timestamptz,
  add column if not exists reroute_tokens_remaining integer not null default 0,
  add column if not exists reward_redemptions_remaining integer not null default 0;

alter table profiles drop constraint if exists profiles_subscription_tier_check;
alter table profiles
  add constraint profiles_subscription_tier_check
  check (subscription_tier in ('none', 'pass', 'pass_plus'));

alter table profiles drop constraint if exists profiles_subscription_status_check;
alter table profiles
  add constraint profiles_subscription_status_check
  check (subscription_status in ('inactive', 'active', 'past_due', 'canceled'));

alter table profiles drop constraint if exists profiles_reroute_tokens_nonnegative;
alter table profiles
  add constraint profiles_reroute_tokens_nonnegative check (reroute_tokens_remaining >= 0);

alter table profiles drop constraint if exists profiles_reward_redemptions_nonnegative;
alter table profiles
  add constraint profiles_reward_redemptions_nonnegative check (reward_redemptions_remaining >= 0);

-- Each Stripe customer/subscription should ever map to exactly one profile.
create unique index if not exists idx_profiles_stripe_customer_id
  on profiles(stripe_customer_id) where stripe_customer_id is not null;
create unique index if not exists idx_profiles_stripe_subscription_id
  on profiles(stripe_subscription_id) where stripe_subscription_id is not null;

-- Same defense-in-depth as every other coins/unlock column: only the
-- subscribe and stripe-webhook edge functions (service role) may ever move
-- these.
revoke update (
  subscription_tier,
  subscription_status,
  stripe_customer_id,
  stripe_subscription_id,
  subscription_current_period_end,
  reroute_tokens_remaining,
  reward_redemptions_remaining
) on profiles from authenticated;

-- Widen the coin ledger's reason enum so grant_subscription_period() below
-- can credit coins via the existing credit_coins() function.
alter table coin_transactions drop constraint if exists coin_transactions_reason_check;
alter table coin_transactions
  add constraint coin_transactions_reason_check
  check (reason in (
    'purchase',
    'unlock_radius',
    'unlock_venue_search',
    'unlock_extra_stops',
    'admin_grant',
    'xp_reward',
    'subscription_grant'
  ));

-- ---------------------------------------------------------------
-- idempotency guard for webhook retries
-- ---------------------------------------------------------------

-- Stripe can redeliver invoice.payment_succeeded for the same invoice.
-- Mirrors the unique-index-on-stripe_payment_intent_id trick from
-- coin_transactions (0007_gamification.sql) but as its own small table,
-- since a subscription grant touches several columns at once rather than
-- a single ledger row.
create table if not exists subscription_invoice_grants (
  stripe_invoice_id text primary key,
  profile_id uuid not null references profiles(id) on delete cascade,
  granted_at timestamptz not null default now()
);

alter table subscription_invoice_grants enable row level security;
-- No policies for authenticated — written only by grant_subscription_period()
-- via the service role, same trust boundary as coin_transactions/profile_badges.

-- ---------------------------------------------------------------
-- badges
-- ---------------------------------------------------------------

insert into badges (key, name, description, emoji, sort_order) values
  ('muso_pass_member', 'MUSO Pass', 'Subscribed to MUSO Pass.', '🎟️', 9),
  ('muso_pass_plus_member', 'MUSO Pass+', 'Subscribed to MUSO Pass+.', '🎫', 10)
on conflict (key) do nothing;

-- ---------------------------------------------------------------
-- grant / deactivate (called from stripe-webhook only, service role)
-- ---------------------------------------------------------------

-- Called once per PAID invoice — the very first one and every monthly
-- renewal alike. Idempotent per Stripe invoice id: returns false (does
-- nothing else) if this invoice was already processed, so a retried
-- webhook delivery can never double-grant coins or reset tokens twice.
create or replace function grant_subscription_period(
  p_profile_id uuid,
  p_tier text,
  p_stripe_invoice_id text,
  p_coins integer,
  p_reroute_tokens integer,
  p_reward_redemptions integer,
  p_period_end timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_count integer;
begin
  insert into subscription_invoice_grants (stripe_invoice_id, profile_id)
  values (p_stripe_invoice_id, p_profile_id)
  on conflict (stripe_invoice_id) do nothing;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    return false; -- already processed this invoice
  end if;

  if p_coins > 0 then
    perform credit_coins(p_profile_id, p_coins, 'subscription_grant');
  end if;

  update profiles set
    subscription_tier = p_tier,
    subscription_status = 'active',
    subscription_current_period_end = p_period_end,
    reroute_tokens_remaining = p_reroute_tokens,
    reward_redemptions_remaining = p_reward_redemptions,
    -- Permanent unlocks — same one-way mechanism as spending coins or
    -- leveling up. The 100mi exclusive tier is deliberately NOT set here;
    -- see the migration header and venues-search.
    unlocked_radius_miles = greatest(unlocked_radius_miles, 50),
    unlocked_stop_count = case when p_tier = 'pass_plus' then greatest(unlocked_stop_count, 5) else unlocked_stop_count end,
    venues_search_unlocked = case when p_tier = 'pass_plus' then true else venues_search_unlocked end
  where id = p_profile_id;

  return true;
end;
$func$;

grant execute on function grant_subscription_period(uuid, text, text, integer, integer, integer, timestamptz) to service_role;

-- Called on subscription cancellation/deletion. Zeroes out the
-- recurring-only entitlements; permanent unlocks (radius/stops/venue
-- search) are untouched, matching the "cancelling never takes back a
-- permanent unlock" rule everywhere else in this schema. The 100mi
-- exclusive tier needs no column change here — it's checked live off
-- subscription_status, which this does update.
create or replace function deactivate_subscription(p_profile_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $func$
begin
  update profiles set
    subscription_status = 'canceled',
    reroute_tokens_remaining = 0,
    reward_redemptions_remaining = 0
  where id = p_profile_id;
end;
$func$;

grant execute on function deactivate_subscription(uuid) to service_role;
