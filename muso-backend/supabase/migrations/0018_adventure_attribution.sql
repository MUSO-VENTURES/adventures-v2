-- MUSO Adventures — Per-adventure coin/badge attribution + missing photo
-- bonus credit (v18)
--
-- Backs the profile "trophy case": each completed adventure should be able
-- to show exactly which badges and coins it earned, not just the player's
-- running totals. Adds adventure_id to the two ledger tables and threads it
-- through credit_coins()/debit_coins()/award_badge() as a new optional
-- trailing parameter — nullable and defaulted, so every existing call site
-- that doesn't pass it keeps working unchanged (radius/venue-search/
-- extra-stops unlocks, Stripe purchases, level-up badges, etc. are
-- correctly NOT tied to a specific adventure).
--
-- Also fixes a real gap found while building this: checkin/index.ts has
-- never actually called credit_coins for the photo-booth bonus, even
-- though the client has displayed "+20 coins" messaging for it all along
-- (CHECKIN_PHOTO_COINS in preview/index.html). 'photo_bonus' is added to
-- the reason allow-list here so that fix (shipped alongside this
-- migration in checkin/index.ts) can actually write a ledger row.

alter table coin_transactions
  add column if not exists adventure_id uuid references adventures(id) on delete set null;
create index if not exists idx_coin_transactions_adventure on coin_transactions(adventure_id);

alter table profile_badges
  add column if not exists adventure_id uuid references adventures(id) on delete set null;
create index if not exists idx_profile_badges_adventure on profile_badges(adventure_id);

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
    'photo_bonus'
  ));

-- Adding a new parameter changes a function's argument-type signature, so
-- `create or replace` alone would create an ambiguous second overload
-- instead of replacing the original — drop the old signature explicitly
-- first, same as any other breaking-signature-change migration.

drop function if exists credit_coins(uuid, integer, text, text);
create or replace function credit_coins(
  p_profile_id uuid,
  p_amount integer,
  p_reason text,
  p_stripe_payment_intent_id text default null,
  p_adventure_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $func$
begin
  if p_amount <= 0 then
    raise exception 'credit_coins amount must be positive';
  end if;

  update profiles set adventure_coins = adventure_coins + p_amount where id = p_profile_id;

  insert into coin_transactions (profile_id, amount, reason, stripe_payment_intent_id, adventure_id)
  values (p_profile_id, p_amount, p_reason, p_stripe_payment_intent_id, p_adventure_id);
end;
$func$;

drop function if exists debit_coins(uuid, integer, text);
create or replace function debit_coins(
  p_profile_id uuid,
  p_amount integer,
  p_reason text,
  p_adventure_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $func$
declare
  affected integer;
begin
  if p_amount <= 0 then
    raise exception 'debit_coins amount must be positive';
  end if;

  update profiles set adventure_coins = adventure_coins - p_amount
  where id = p_profile_id and adventure_coins >= p_amount;

  get diagnostics affected = row_count;
  if affected = 0 then
    return false;
  end if;

  insert into coin_transactions (profile_id, amount, reason, adventure_id)
  values (p_profile_id, -p_amount, p_reason, p_adventure_id);

  return true;
end;
$func$;

drop function if exists award_badge(uuid, text, jsonb);
create or replace function award_badge(
  p_profile_id uuid,
  p_badge_key text,
  p_meta jsonb default '{}'::jsonb,
  p_adventure_id uuid default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_rows integer;
begin
  insert into profile_badges (profile_id, badge_key, meta, adventure_id)
  values (p_profile_id, p_badge_key, p_meta, p_adventure_id)
  on conflict (profile_id, badge_key) do nothing;

  get diagnostics v_rows = row_count;
  return v_rows > 0;
end;
$func$;

grant execute on function award_badge(uuid, text, jsonb, uuid) to service_role;
