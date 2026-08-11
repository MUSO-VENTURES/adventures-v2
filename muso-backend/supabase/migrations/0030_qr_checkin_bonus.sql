-- Real venue check-in verification: a player either scans the physical QR
-- code posted at a venue (a +10 coin bonus, since it's the strongest proof
-- they're actually there) or, if they can't find one (the venue isn't part
-- of the MUSO network yet, or the code is missing/damaged), checks in via
-- geolocation instead (server-verified within 100ft of the venue's stored
-- lat/lng, no bonus). See checkin/index.ts's verifyMethod handling.

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
    'adventure_complete',
    'referral_bonus',
    'qr_checkin_bonus'
  ));
