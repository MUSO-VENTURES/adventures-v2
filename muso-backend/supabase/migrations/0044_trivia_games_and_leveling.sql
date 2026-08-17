-- MUSO Adventures — Trivia Break: 5-question games + difficulty leveling (v44)
--
-- Reworks pacing: instead of one long, unbounded trivia session where
-- difficulty ramps within itself (the old resolveDifficulty(roundNumber)
-- in _shared/triviaGenerator.ts), trivia is now played in fixed 5-question
-- "games," each entirely at ONE difficulty tier. A party starts at 'easy'.
-- Going a perfect 5/5 in a game levels their next game up a tier (easy ->
-- medium -> hard, capped at hard); anything less than perfect leaves the
-- tier unchanged for their next game — there's no demotion.
--
-- trivia_progress is scoped by (party_id, adventure_id, mode) rather than
-- just (party_id, adventure_id): solo and group play get independent
-- progressions even within the same adventure, since round_number (which
-- both game-boundary math and question count derive from) is likewise
-- counted per mode now (see trivia/index.ts's nextRoundNumber) — otherwise
-- a party mixing solo and group play in one adventure would have their
-- round numbers interleave and "games" would straddle both modes.
--
-- Game-end outcome (correct count / leveled-up / new difficulty) is
-- written directly onto the 5th round of each game, not just returned
-- from that one player's submitAnswer/advanceTurn HTTP response — group
-- mode needs every party member's client to see the same "game over, you
-- leveled up!" moment via the existing realtime trivia_rounds channel,
-- the same "server writes once, every client converges via realtime"
-- principle the rest of this feature already uses (see 0040_trivia_break.sql).

create table if not exists trivia_progress (
  party_id uuid not null references parties(id) on delete cascade,
  adventure_id uuid not null references adventures(id) on delete cascade,
  mode text not null check (mode in ('solo', 'group')),
  difficulty text not null default 'easy' check (difficulty in ('easy', 'medium', 'hard')),
  updated_at timestamptz not null default now(),
  primary key (party_id, adventure_id, mode)
);

alter table trivia_progress enable row level security;

create policy "party members read trivia progress" on trivia_progress for select using (
  is_party_member(party_id)
);
-- No insert/update policy — only the trivia edge function's service-role
-- client ever writes this, same "no direct client mutation" posture as
-- every other gamification-state table in this schema.

-- Game-end summary, set once when the 5th round of a game resolves/
-- expires; null on every other round. Nullable rather than a separate
-- table — this is metadata about the round it's attached to, not an
-- independent entity, and keeping it inline means it rides the existing
-- trivia_rounds realtime publication with no new subscription needed.
alter table trivia_rounds
  add column if not exists game_correct_count int,
  add column if not exists game_leveled_up boolean,
  add column if not exists game_new_difficulty text;

alter table trivia_rounds
  drop constraint if exists trivia_rounds_game_new_difficulty_check;
alter table trivia_rounds
  add constraint trivia_rounds_game_new_difficulty_check
  check (game_new_difficulty is null or game_new_difficulty in ('easy', 'medium', 'hard'));
