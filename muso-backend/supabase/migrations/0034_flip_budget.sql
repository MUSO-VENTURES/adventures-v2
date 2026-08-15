-- MUSO Adventures — solo coin flip budget (v34)
--
-- Monetizes the solo "Flip the Coin" mini game (assets/coin-flip.js via
-- minigames/index.ts's heads_or_tails entry) without touching the head-to-
-- head challenge system (0032/0033) at all — challenges already cost a
-- willing opponent and pay out real XP, so they stay unlimited. This is
-- purely about the casual "make the call" solo flip.
--
-- Budget, per adventure (resets to nothing carried over once a new
-- adventure starts, since the row is keyed by adventure_id): 5 free flips,
-- plus one more automatically for every stop the player has checked into
-- on *this* adventure (computed live from check_ins, not stored — a
-- player's checkin count can only grow, never needs correcting), plus
-- however many bonus_flips_purchased they've bought with Adventure Coins.
-- Only enforced while a player is inside an active adventure — see
-- minigames/index.ts's flipStatus/useFlip actions for the "no active
-- adventure = unlimited" case, since there's no adventure to scope a
-- budget against outside of one.

create table if not exists minigame_flip_usage (
  profile_id uuid not null references profiles(id) on delete cascade,
  adventure_id uuid not null references adventures(id) on delete cascade,
  flips_used int not null default 0 check (flips_used >= 0),
  bonus_flips_purchased int not null default 0 check (bonus_flips_purchased >= 0),
  updated_at timestamptz not null default now(),
  primary key (profile_id, adventure_id)
);

alter table minigame_flip_usage enable row level security;

-- A player's own flip usage is private to them, not party-shared like
-- coin_flip_challenges — no other party member needs to see how many
-- solo flips someone has left.
create policy "players read their own flip usage" on minigame_flip_usage for select using (
  profile_id = auth.uid()
);

-- No insert/update policy — only consume_flip()/add_bonus_flips() below
-- (called from minigames/index.ts's service-role client) ever write this
-- table, same "no direct client mutation" reasoning as every other
-- gamification-state table in this schema.

-- Atomically checks the player's remaining budget and spends one flip if
-- there's room. The `for update` row lock (after the upsert guarantees the
-- row exists) is what makes this safe against two flips fired back-to-back
-- before the first response lands — without it, two concurrent calls could
-- both read the same "1 remaining" and both succeed.
create or replace function consume_flip(p_profile_id uuid, p_adventure_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_checkins int;
  v_used int;
  v_bonus int;
  v_allowance int;
  v_remaining int;
begin
  select count(*) into v_checkins from check_ins
    where checked_in_by = p_profile_id and adventure_id = p_adventure_id;

  insert into minigame_flip_usage (profile_id, adventure_id)
    values (p_profile_id, p_adventure_id)
    on conflict (profile_id, adventure_id) do nothing;

  select flips_used, bonus_flips_purchased into v_used, v_bonus
    from minigame_flip_usage
    where profile_id = p_profile_id and adventure_id = p_adventure_id
    for update;

  v_allowance := 5 + v_checkins + v_bonus;
  v_remaining := v_allowance - v_used;

  if v_remaining <= 0 then
    return jsonb_build_object('ok', false, 'remaining', 0, 'allowance', v_allowance, 'used', v_used);
  end if;

  update minigame_flip_usage
    set flips_used = flips_used + 1, updated_at = now()
    where profile_id = p_profile_id and adventure_id = p_adventure_id;

  return jsonb_build_object('ok', true, 'remaining', v_remaining - 1, 'allowance', v_allowance, 'used', v_used + 1);
end;
$func$;

grant execute on function consume_flip(uuid, uuid) to service_role;

-- Called after a successful debit_coins spend (minigames/index.ts's
-- buyFlips action) — a plain UPDATE with a column-on-column increment is
-- already atomic per-row in Postgres, the upsert just guarantees the row
-- exists first for a player who hasn't flipped yet this adventure.
create or replace function add_bonus_flips(p_profile_id uuid, p_adventure_id uuid, p_amount int)
returns void
language plpgsql
security definer
set search_path = public
as $func$
begin
  if p_amount <= 0 then
    raise exception 'add_bonus_flips amount must be positive';
  end if;

  insert into minigame_flip_usage (profile_id, adventure_id)
    values (p_profile_id, p_adventure_id)
    on conflict (profile_id, adventure_id) do nothing;

  update minigame_flip_usage
    set bonus_flips_purchased = bonus_flips_purchased + p_amount, updated_at = now()
    where profile_id = p_profile_id and adventure_id = p_adventure_id;
end;
$func$;

grant execute on function add_bonus_flips(uuid, uuid, int) to service_role;

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
    'buy_flips'
  ));
