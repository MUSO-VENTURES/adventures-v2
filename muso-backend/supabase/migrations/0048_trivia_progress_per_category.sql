-- MUSO Adventures — scope Trivia Break round numbering/leveling per category (v48)
--
-- Bug: nextRoundNumber/getOrCreateProgress/maybeCompleteGame in trivia/
-- index.ts all scope by (party_id, adventure_id, mode) only — not
-- category. Since 0047_trivia_freeplay.sql let a player switch categories
-- within one party+adventure(+freeplay)+mode "slot" (the freeplay picker,
-- or the mid-adventure "change category" override), round_number kept
-- counting across categories instead of resetting: picking a second
-- category after 3 rounds of a first one started question 4/5 instead of
-- 1/5, and maybeCompleteGame's "last 5 rounds" window could span two
-- different categories' questions in one recap.
--
-- Fix is category-scoping every one of those three queries (see
-- trivia/index.ts) — trivia_progress needs a category column to make that
-- possible for difficulty tracking specifically (trivia_rounds already has
-- one). Existing trivia_progress rows predate per-category tracking and
-- have no meaningful category to backfill against, so they're cleared
-- rather than guessed at — getOrCreateProgress recreates a fresh 'easy'
-- row per (party, adventure, mode, category) the next time each is played,
-- which is the same graceful "first game is never too hard" default any
-- new combination already gets.

delete from trivia_progress;

-- Table is empty as of the delete above, so category can go straight to
-- NOT NULL with no default/backfill needed.
alter table trivia_progress add column if not exists category text not null;

alter table trivia_progress
  drop constraint if exists trivia_progress_category_check;
alter table trivia_progress
  add constraint trivia_progress_category_check
  check (category in ('dogs', 'great_outdoors', 'curiosities', 'food_for_thought', 'after_hours', 'wtf'));

drop index if exists idx_trivia_progress_unique;
create unique index idx_trivia_progress_unique
  on trivia_progress(party_id, coalesce(adventure_id, '00000000-0000-0000-0000-000000000000'::uuid), mode, category);
