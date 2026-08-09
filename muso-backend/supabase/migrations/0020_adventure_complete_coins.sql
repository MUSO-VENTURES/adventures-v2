-- MUSO Adventures — adventure-completion coin bonus (v20)
--
-- Adds 'adventure_complete' to the coin_transactions reason allow-list so
-- checkin/index.ts can credit a one-time +20 coin bonus the moment a
-- player finishes every stop on an adventure — same completion check that
-- already awards the 'adventure_completed' badge, just also crediting
-- coins now. Paired with dropping CHECKIN_PHOTO_COINS from 20 to 10 (code
-- change only, no schema impact) so per-stop photos stay worth something
-- without also making the one-time completion bonus redundant.

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
    'extra_roll',
    'photo_bonus',
    'adventure_complete'
  ));
