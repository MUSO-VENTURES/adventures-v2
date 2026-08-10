-- MUSO Adventures — Wine Country Adventure (v22)
--
-- A themed variant of the fork-in-the-road real-venue adventure that locks
-- venue search to wineries/tasting rooms instead of the player's regular
-- interests. Reuses the entire existing engine (init/advance/reroll/choose,
-- offered_choices, candidate_pool) — this column is the only schema change
-- needed, since it's just a flag real-venue-adventure/index.ts reads back
-- on every subsequent stop to keep reapplying the same category lock.

alter table routes
  add column if not exists venue_theme text; -- null = default fork-in-the-road; 'wine_country' = locked to wineries
