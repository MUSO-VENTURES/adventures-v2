-- MUSO Adventures — paid custom flip naming (v36)
--
-- The solo Flip's prompt picker (preview/index.html) offers 6 free preset
-- prompts plus a "name your own" option — the presets consume the normal
-- per-adventure flip budget (0034_flip_budget.sql) same as ever, but typing
-- a custom name costs a flat coin fee, charged once at naming time via
-- minigames/index.ts's nameCustomFlip action, independent of the flip
-- budget entirely (it's chargeable even outside an active adventure).

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
    'qr_checkin_bonus',
    'unlock_minigame',
    'buy_flips',
    'custom_flip_prompt'
  ));
