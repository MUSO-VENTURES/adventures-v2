-- MUSO Adventures — head-to-head coin flip challenges (v32)
--
-- Lets any two members of the same active-adventure party challenge each
-- other to a coin flip at any time during that adventure — the multiplayer
-- sibling of the always-free solo flip in minigames/index.ts's
-- heads_or_tails entry. The challenger picks a side when issuing the
-- challenge; since a coin only has two faces, the opponent is left the
-- other one automatically rather than risking both players picking the
-- same side and needing a tiebreak. The actual flip result is decided
-- server-side the instant the opponent accepts — never client-side, since
-- two different devices need to land on the exact same outcome — and the
-- winner is paid out via the same award_xp RPC checkin/index.ts already
-- uses for check-in XP.

create table if not exists coin_flip_challenges (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  adventure_id uuid not null references adventures(id) on delete cascade,
  challenger_id uuid not null references profiles(id) on delete cascade,
  opponent_id uuid not null references profiles(id) on delete cascade,
  challenger_call text not null check (challenger_call in ('heads', 'tails')),
  status text not null default 'pending' check (status in ('pending', 'declined', 'cancelled', 'resolved')),
  result text check (result in ('heads', 'tails')),
  winner_id uuid references profiles(id) on delete set null,
  xp_awarded int,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint coin_flip_challenges_distinct_players check (challenger_id <> opponent_id)
);

create index if not exists idx_coin_flip_challenges_party on coin_flip_challenges(party_id);
create index if not exists idx_coin_flip_challenges_opponent on coin_flip_challenges(opponent_id, status);
create index if not exists idx_coin_flip_challenges_challenger on coin_flip_challenges(challenger_id, status);

alter table coin_flip_challenges enable row level security;

-- Same party-membership check as party_invites (0027_social_party_
-- invites.sql) — any current party member can see its challenges, not
-- just the two players involved, which also lets the realtime channel
-- (already scoped to party_id, see ensurePartyRealtime in preview/
-- index.html) filter this table the exact same way it already filters
-- party_members/party_invites.
create policy "party members read coin flip challenges" on coin_flip_challenges for select using (
  is_party_member(party_id)
);

-- No insert/update policy on purpose — same "no direct client mutation"
-- reasoning as party_invites: issuing a challenge, accepting/declining it,
-- deciding the flip result, and paying out XP all go through the
-- minigames edge function's service-role client only.

-- Idempotent, same pattern as 0027_social_party_invites.sql.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'coin_flip_challenges'
  ) then
    alter publication supabase_realtime add table coin_flip_challenges;
  end if;
end $$;
