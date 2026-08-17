-- MUSO Adventures — Trivia Break categories + difficulty (v43)
--
-- Replaces trivia's original content model (questions generated live from
-- the current adventure's own route_stops/venues/venue_reviews — "which
-- venue is at stop 3?") with a curated bank of six fixed categories
-- (Furry Friends, Great Outdoors, Curiosities, Food for Thought, After
-- Hours, WTF?!), each with three difficulty tiers a round progresses
-- through over the course of a sitting. See
-- _shared/triviaGenerator.ts for the bank itself and the venue_theme ->
-- category mapping (VENUE_THEME_TO_CATEGORY) that lets the game pick a
-- category automatically from whichever adventure the party is playing,
-- with no extra picker screen needed.
--
-- 11 real trivia_rounds rows already exist on this project from testing
-- the original content model (2 still mid-round, status='answering') —
-- category/difficulty are added nullable first, backfilled for those
-- existing rows, then locked down not-null, so this is safe against
-- already-live data rather than assuming an empty table.

alter table trivia_rounds
  add column if not exists category text,
  add column if not exists difficulty text;

-- Old rows predate categorization entirely — 'wtf'/'easy' is as good a
-- default as any for rows that are already resolved (or, for the 2 still
-- 'answering', about to be timed out by the client's own advanceTurn
-- call); nothing reads category/difficulty off an in-flight legacy round.
update trivia_rounds
set category = coalesce(category, 'wtf'), difficulty = coalesce(difficulty, 'easy')
where category is null or difficulty is null;

alter table trivia_rounds
  alter column category set not null,
  alter column difficulty set not null;

alter table trivia_rounds
  drop constraint if exists trivia_rounds_category_check;
alter table trivia_rounds
  add constraint trivia_rounds_category_check
  check (category in ('furry_friends', 'great_outdoors', 'curiosities', 'food_for_thought', 'after_hours', 'wtf'));

alter table trivia_rounds
  drop constraint if exists trivia_rounds_difficulty_check;
alter table trivia_rounds
  add constraint trivia_rounds_difficulty_check
  check (difficulty in ('easy', 'medium', 'hard'));

create index if not exists idx_trivia_rounds_category on trivia_rounds(category);

-- 'curated' replaces 'template'/'fallback' as the meaningful value going
-- forward (every question now comes from the static TRIVIA_BANK) — old
-- values stay valid on the constraint so existing rows (all still
-- 'template') don't need touching, 'llm' stays reserved as the future
-- swap-point _shared/triviaGenerator.ts's header comment already
-- describes.
alter table trivia_rounds
  drop constraint if exists trivia_rounds_source_check;
alter table trivia_rounds
  add constraint trivia_rounds_source_check
  check (source in ('template', 'fallback', 'curated', 'llm'));
