-- MUSO Adventures — em-dash cleanup in player-facing copy (v27)
--
-- Every other em-dash in player-facing text lived in the frontend/edge
-- functions and was fixed there directly. These two are the only
-- player-facing strings that live in already-applied migrations/seed data,
-- so they need an UPDATE (editing the old migration file itself wouldn't
-- change what's already in the database).

update route_stops
set description = 'A hidden speakeasy, password required at the door.'
where description = 'A hidden speakeasy — password required at the door.';

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
    return jsonb_build_object('ok', false, 'error', 'This theme unlocks via a special achievement, not available yet.');
  end if;
end;
$$;
