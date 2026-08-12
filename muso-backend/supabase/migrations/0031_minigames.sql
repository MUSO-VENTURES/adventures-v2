-- Mini games: quick, optional play elements that unlock via gameplay
-- milestones (the first one unlocks automatically on a player's first
-- check-in — see checkin/index.ts) or can be bought outright with
-- Adventure Coins (see minigames/index.ts). Game mechanics/content for
-- each one ship separately from this app; this table only tracks
-- per-profile unlock state so the picker can show Play vs Locked and gate
-- the coin-spend path — same "one auditable table, service-role-only
-- writes" shape as profile_badges.

create table if not exists profile_minigames (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references profiles(id) on delete cascade,
  minigame_key text not null,
  unlocked_via text not null check (unlocked_via in ('first_checkin', 'level', 'purchase')),
  unlocked_at timestamptz not null default now(),
  unique (profile_id, minigame_key)
);

alter table profile_minigames enable row level security;

drop policy if exists "read own minigame unlocks" on profile_minigames;
create policy "read own minigame unlocks" on profile_minigames
  for select using (auth.uid() = profile_id);

-- No insert/update/delete policy for authenticated users — only the
-- service-role client (minigames edge function's unlock action, and
-- checkin/index.ts's first-checkin auto-unlock) ever writes this table.

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
    'unlock_minigame'
  ));
