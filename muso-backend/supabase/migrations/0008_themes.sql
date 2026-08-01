-- 0008_themes.sql
-- Unlockable visual "skins" for the player-facing pages (preview page and
-- eventually the full app). 'default' is the light/playful look already
-- live and must always exist as a free, always-unlocked baseline. New skins
-- can be added any time a design is ready by inserting a themes row and
-- flipping is_active to true once the CSS/assets for it actually exist —
-- no migration required to add a theme, only to add a new *unlock method*
-- if one doesn't exist yet (free / level / coins / achievement).

create table if not exists public.themes (
  id text primary key,
  name text not null,
  description text,
  unlock_method text not null default 'free'
    check (unlock_method in ('free', 'level', 'coins', 'achievement')),
  unlock_level integer,
  unlock_cost_coins integer,
  achievement_key text,
  sort_order integer not null default 0,
  -- Flip true once this theme's CSS/assets are actually built. Rows can
  -- exist (e.g. for planning/curation) before that without being
  -- selectable or unlockable.
  is_active boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.themes (id, name, description, unlock_method, sort_order, is_active)
values ('default', 'MUSO Classic', 'The original light, playful MUSO look.', 'free', 0, true)
on conflict (id) do nothing;

alter table public.themes enable row level security;

drop policy if exists "themes are publicly readable" on public.themes;
create policy "themes are publicly readable" on public.themes
  for select using (true);

-- Which themes each player has earned/bought. 'default' never needs a row
-- here since it's free for everyone (see unlock_theme()/activate_theme()
-- below) — this table only records paid or earned unlocks.
create table if not exists public.profile_theme_unlocks (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  theme_id text not null references public.themes(id) on delete cascade,
  unlocked_at timestamptz not null default now(),
  method text not null check (method in ('level', 'coins', 'achievement')),
  primary key (profile_id, theme_id)
);

alter table public.profile_theme_unlocks enable row level security;

drop policy if exists "users can view own theme unlocks" on public.profile_theme_unlocks;
create policy "users can view own theme unlocks" on public.profile_theme_unlocks
  for select using (auth.uid() = profile_id);

-- Defense-in-depth, same pattern as the coins/xp columns in
-- 0007_gamification.sql: a client can read its own unlocks and the public
-- theme catalog directly, but can never insert a "free" unlock for itself
-- or flip its own active theme without going through the unlock-feature
-- edge function (service role), which enforces the real level/coin checks.
revoke insert, update, delete on public.profile_theme_unlocks from authenticated;

alter table public.profiles
  add column if not exists active_theme_id text not null default 'default'
    references public.themes(id);

revoke update (active_theme_id) on public.profiles from authenticated;

-- Atomically checks unlock eligibility (level or coins, via the existing
-- debit_coins() from 0007_gamification.sql) and records the unlock. Called
-- from unlock-feature with the service role, never directly by clients.
create or replace function public.unlock_theme(p_profile_id uuid, p_theme_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_theme public.themes%rowtype;
  v_profile public.profiles%rowtype;
  v_paid boolean;
begin
  select * into v_theme from public.themes where id = p_theme_id and is_active = true;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Theme not found or not yet available.');
  end if;

  if v_theme.unlock_method = 'free'
     or exists (
       select 1 from public.profile_theme_unlocks
       where profile_id = p_profile_id and theme_id = p_theme_id
     ) then
    return jsonb_build_object('ok', true, 'alreadyUnlocked', true);
  end if;

  select * into v_profile from public.profiles where id = p_profile_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Profile not found.');
  end if;

  if v_theme.unlock_method = 'level' then
    if coalesce(v_profile.level, 1) >= coalesce(v_theme.unlock_level, 999999) then
      insert into public.profile_theme_unlocks (profile_id, theme_id, method)
        values (p_profile_id, p_theme_id, 'level');
      return jsonb_build_object('ok', true, 'method', 'level');
    end if;
    return jsonb_build_object('ok', false, 'error', format('Requires level %s.', v_theme.unlock_level));

  elsif v_theme.unlock_method = 'coins' then
    select public.debit_coins(p_profile_id, coalesce(v_theme.unlock_cost_coins, 0), 'unlock_theme_' || p_theme_id)
      into v_paid;
    if not v_paid then
      return jsonb_build_object(
        'ok', false,
        'error', format('Not enough Adventure Coins. Need %s.', v_theme.unlock_cost_coins)
      );
    end if;
    insert into public.profile_theme_unlocks (profile_id, theme_id, method)
      values (p_profile_id, p_theme_id, 'coins');
    return jsonb_build_object('ok', true, 'method', 'coins', 'spent', v_theme.unlock_cost_coins);

  else
    return jsonb_build_object('ok', false, 'error', 'This theme unlocks via a special achievement — not available yet.');
  end if;
end;
$$;

grant execute on function public.unlock_theme(uuid, text) to service_role;

-- Switches a player's active theme. Only allowed if it's free or already
-- unlocked — the actual gate, so a client can never "activate" its way
-- around paying/leveling for a locked skin.
create or replace function public.activate_theme(p_profile_id uuid, p_theme_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_theme public.themes%rowtype;
begin
  select * into v_theme from public.themes where id = p_theme_id and is_active = true;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'Theme not found or not yet available.');
  end if;

  if v_theme.unlock_method <> 'free'
     and not exists (
       select 1 from public.profile_theme_unlocks
       where profile_id = p_profile_id and theme_id = p_theme_id
     ) then
    return jsonb_build_object('ok', false, 'error', 'Unlock this theme before applying it.');
  end if;

  update public.profiles set active_theme_id = p_theme_id where id = p_profile_id;
  return jsonb_build_object('ok', true, 'activeThemeId', p_theme_id);
end;
$$;

grant execute on function public.activate_theme(uuid, text) to service_role;
