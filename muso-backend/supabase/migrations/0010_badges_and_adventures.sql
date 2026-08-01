-- MUSO Adventures — Achievement badges + real XP awarding (v10)
--
-- Backs the "start an adventure -> check in at your first stop -> unlock
-- your profile + get a celebration" flow. Two new pieces:
--   1. A generic, idempotent badge system (badges + profile_badges) that any
--      edge function can award into via award_badge() — mirrors the
--      SECURITY DEFINER pattern used throughout this schema
--      (is_party_member(), credit_coins(), my_leaderboard_rank(), ...).
--   2. Real xp awarding via award_xp(). profiles.level has been a generated
--      column since 0007_gamification.sql (floor(xp/100)+1), but nothing
--      has ever actually credited xp — this is the first real xp path.
--
-- Safe to run once, after 0009_profile_extensions.sql.

-- ---------------------------------------------------------------
-- badges (reference table, same shape as moods/twists)
-- ---------------------------------------------------------------

create table if not exists badges (
  key text primary key,               -- 'first_checkin', 'level_5', ...
  name text not null,
  description text not null,
  emoji text not null default '🏅',
  sort_order int not null default 0
);

insert into badges (key, name, description, emoji, sort_order) values
  ('first_checkin', 'First Steps', 'Checked in at your first MUSO stop.', '🎉', 1),
  ('level_5', 'Level 5', 'Reached Level 5.', '⭐', 2),
  ('level_10', 'Level 10', 'Reached Level 10.', '🌟', 3),
  ('radius_unlocked', 'Explorer Range', 'Unlocked extended search radius.', '🗺️', 4),
  ('venue_search_unlocked', 'Venue Hunter', 'Unlocked real venue search.', '🔍', 5),
  ('theme_unlocked', 'Style Unlocked', 'Unlocked your first visual theme.', '🎨', 6),
  ('adventure_completed', 'Route Complete', 'Finished every stop on an adventure.', '🏁', 7)
on conflict (key) do nothing;

alter table badges enable row level security;
drop policy if exists "badges readable by authenticated" on badges;
create policy "badges readable by authenticated" on badges for select using (auth.role() = 'authenticated');

-- ---------------------------------------------------------------
-- profile_badges (earned badges — award-only from the server side)
-- ---------------------------------------------------------------

create table if not exists profile_badges (
  profile_id uuid not null references profiles(id) on delete cascade,
  badge_key text not null references badges(key) on delete cascade,
  earned_at timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb,
  primary key (profile_id, badge_key)
);

create index if not exists idx_profile_badges_profile on profile_badges(profile_id, earned_at desc);

alter table profile_badges enable row level security;
drop policy if exists "user reads own badges" on profile_badges;
create policy "user reads own badges" on profile_badges for select using (auth.uid() = profile_id);
-- No insert/update/delete policy for authenticated — badges are only ever
-- awarded server-side via award_badge() below, called from edge functions
-- using the service role. Same trust boundary as coin_transactions.

-- Idempotent award: returns whether THIS call is the first time the badge
-- was earned, so the caller (an edge function) knows whether to surface a
-- celebration. Never errors on a repeat award — safe to call unconditionally
-- every time the qualifying event happens.
create or replace function award_badge(p_profile_id uuid, p_badge_key text, p_meta jsonb default '{}'::jsonb)
returns boolean
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_rows integer;
begin
  insert into profile_badges (profile_id, badge_key, meta)
  values (p_profile_id, p_badge_key, p_meta)
  on conflict (profile_id, badge_key) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$func$;

grant execute on function award_badge(uuid, text, jsonb) to service_role;

-- ---------------------------------------------------------------
-- real xp awarding
-- ---------------------------------------------------------------

create or replace function award_xp(p_profile_id uuid, p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_old_level integer;
  v_new_level integer;
begin
  if p_amount <= 0 then
    raise exception 'award_xp amount must be positive';
  end if;

  select level into v_old_level from profiles where id = p_profile_id;
  update profiles set xp = xp + p_amount where id = p_profile_id;
  select level into v_new_level from profiles where id = p_profile_id;

  return jsonb_build_object(
    'oldLevel', v_old_level,
    'newLevel', v_new_level,
    'leveledUp', v_new_level > v_old_level
  );
end;
$func$;

grant execute on function award_xp(uuid, integer) to service_role;
