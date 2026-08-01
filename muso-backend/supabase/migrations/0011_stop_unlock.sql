-- MUSO Adventures — Free-tier stop cap + stop-count unlock (v11)
--
-- Business rule: every player's free monthly adventure defaults to 3 stops.
-- Those first 3 stop slots are the ones route curators should fill with
-- paying partner venues (premium/sponsor tier) first, since they're the
-- only slots guaranteed to be seen by every player, free or not — stops 4
-- and 5 are only ever seen by players who've unlocked them. That's a
-- content/curation policy for whoever authors route_stops rows, not
-- something enforced by a DB constraint here (a hard constraint risks
-- breaking narrative ordering on existing routes, e.g. a route that ends on
-- a "sunrise lookout" finale stop).
--
-- Raising a player's cap to 5 works exactly like the existing radius /
-- venue_search unlocks from 0007_gamification.sql: free once they hit a
-- level threshold (reached via normal check-in XP — i.e. "through
-- participation"), or purchasable with Adventure Coins ("credits/rewards"
-- if earned via xp_reward, or "pay to play" if bought via buy-coins/Stripe).
-- Same coins ledger, same service-role-only mutation pattern.

alter table profiles
  add column if not exists unlocked_stop_count integer not null default 3;

alter table profiles
  drop constraint if exists profiles_stop_count_range;
alter table profiles
  add constraint profiles_stop_count_range check (unlocked_stop_count between 3 and 5);

-- Same defense-in-depth as xp/coins/radius/venues_search_unlocked: only the
-- unlock-feature edge function (service role) may ever move this value.
revoke update (unlocked_stop_count) on profiles from authenticated;

-- Widen the coin ledger's reason enum so debit_coins(..., p_reason:
-- 'unlock_extra_stops') from unlock-feature can actually write a row.
alter table coin_transactions
  drop constraint if exists coin_transactions_reason_check;
alter table coin_transactions
  add constraint coin_transactions_reason_check
  check (reason in (
    'purchase',
    'unlock_radius',
    'unlock_venue_search',
    'unlock_extra_stops',
    'admin_grant',
    'xp_reward'
  ));

-- New badge for this unlock (mirrors the pattern in
-- 0010_badges_and_adventures.sql — award_badge()/badges table already
-- exist, this just adds the row so awardBadge('extra_stops_unlocked')
-- resolves to a real badge instead of silently no-op-ing).
insert into badges (key, name, description, emoji, sort_order)
values (
  'extra_stops_unlocked',
  'Full Itinerary',
  'Unlocked all 5 stops on your monthly adventure.',
  '🧭',
  8
)
on conflict (key) do nothing;
