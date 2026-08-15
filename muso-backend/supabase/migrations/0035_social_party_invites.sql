-- MUSO Adventures — social party features (v27)
--
-- Three things: (1) check-ins move from "one per stop for the whole party"
-- to "one per person per stop," the foundation the real-time per-person
-- finds feed and roster depend on; (2) a real invite/QR-join model
-- (party_invites), replacing the fully decorative QR check-in graphic
-- that existed before with something that actually generates and claims
-- real invite codes; (3) Realtime enabled on the tables the live feed
-- reads from, so the roster/feed update without polling.

-- ---------------------------------------------------------------
-- 1. Per-person check-ins
-- ---------------------------------------------------------------

-- Postgres's default name for the inline unique(...) declared at table
-- creation in 0001_init.sql follows the standard <table>_<cols>_key
-- convention.
alter table check_ins
  drop constraint if exists check_ins_adventure_id_route_stop_id_key;

alter table check_ins
  add constraint check_ins_adventure_id_route_stop_id_checked_in_by_key
  unique (adventure_id, route_stop_id, checked_in_by);

-- ---------------------------------------------------------------
-- 2. Invites
-- ---------------------------------------------------------------

create table if not exists party_invites (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  adventure_id uuid references adventures(id) on delete set null,
  created_by uuid not null references profiles(id) on delete cascade,
  invite_code text not null unique,
  -- Snapshot at creation time so a later party-size change doesn't
  -- retroactively change what an already-issued invite pays out.
  party_size_at_creation int not null,
  status text not null default 'pending' check (status in ('pending', 'claimed', 'expired')),
  claimed_by uuid references profiles(id) on delete set null,
  claimed_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_party_invites_party on party_invites(party_id);
create index if not exists idx_party_invites_code on party_invites(invite_code);

alter table party_invites enable row level security;

-- Any current member of the party can see its invites (so the roster
-- panel can show "waiting for someone to join" slots) — same
-- party-membership check shape used by check_ins/adventures policies.
create policy "party members read party invites" on party_invites for select using (
  exists (
    select 1 from party_members m
    where m.party_id = party_invites.party_id and m.profile_id = auth.uid()
  )
);

-- No insert/update policy on purpose — invites are only ever created or
-- claimed through the party-social edge function's service-role client,
-- same "no direct client mutation" pattern as venue_offer_events. This
-- matters here specifically because claiming an invite pays out a real
-- coin bonus to the inviter — that logic must not be something a client
-- can trigger by writing directly to this table.

-- ---------------------------------------------------------------
-- 3. Referral bonus coin reason
-- ---------------------------------------------------------------

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
    'referral_bonus'
  ));

-- ---------------------------------------------------------------
-- 4. Realtime — powers the live roster/feed without polling
-- ---------------------------------------------------------------

-- Idempotent — "alter publication ... add table" errors if the table is
-- already a member, and this migration should be safe to re-run.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'check_ins'
  ) then
    alter publication supabase_realtime add table check_ins;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'party_members'
  ) then
    alter publication supabase_realtime add table party_members;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'party_invites'
  ) then
    alter publication supabase_realtime add table party_invites;
  end if;
end $$;
