-- MUSO Adventures — Trivia Break freeplay: no adventure required (v47)
--
-- Trivia's "first stage" (a solo round, played from a category the player
-- picks themselves) is now playable with no active adventure at all — the
-- category picker becomes the default starting screen instead of the
-- "start an adventure first" block. adventure_id becomes optional across
-- trivia_rounds/trivia_progress; NULL means freeplay. See trivia/index.ts's
-- startRound for the category-required-when-freeplay validation.

-- trivia_progress's primary key was (party_id, adventure_id, mode) —
-- Postgres primary-key columns can never be nullable, so the constraint has
-- to come off BEFORE adventure_id's NOT NULL can be dropped (attempting
-- that in the other order fails: "column is in a primary key"). The key
-- moves to a plain surrogate id, with the same coalesce()'d uniqueness
-- (below) taking over the "one progress row per party+adventure(+freeplay)+
-- mode" invariant the old composite PK enforced.
alter table trivia_progress drop constraint if exists trivia_progress_pkey;
alter table trivia_progress add column if not exists id uuid primary key default gen_random_uuid();

alter table trivia_rounds alter column adventure_id drop not null;
alter table trivia_progress alter column adventure_id drop not null;

-- Both "one live round" partial unique indexes assumed adventure_id was
-- always non-null. Postgres treats NULL as distinct from itself in a plain
-- unique index/constraint, so without the coalesce() below a player could
-- rack up unlimited concurrent "live" freeplay rounds instead of being
-- handed back their existing one.
drop index if exists idx_trivia_rounds_one_live_group;
create unique index idx_trivia_rounds_one_live_group
  on trivia_rounds(party_id, coalesce(adventure_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where status in ('buzzing', 'answering') and mode = 'group';

drop index if exists idx_trivia_rounds_one_live_solo;
create unique index idx_trivia_rounds_one_live_solo
  on trivia_rounds(party_id, coalesce(adventure_id, '00000000-0000-0000-0000-000000000000'::uuid), initiator_profile_id)
  where status in ('buzzing', 'answering') and mode = 'solo';

create unique index if not exists idx_trivia_progress_unique
  on trivia_progress(party_id, coalesce(adventure_id, '00000000-0000-0000-0000-000000000000'::uuid), mode);
