-- MUSO Adventures — Adventure Coins reason for reroll spend (v17)
--
-- Widens the coin ledger's reason enum so debit_coins(..., p_reason:
-- 'extra_roll') from the new real-venue-adventure edge function's reroll
-- action can actually write a row — same drop/recreate pattern used in
-- 0011_stop_unlock.sql when 'unlock_extra_stops' was added.

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
    'xp_reward',
    'extra_roll'
  ));
