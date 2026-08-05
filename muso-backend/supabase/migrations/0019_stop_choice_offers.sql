-- MUSO Adventures — "Fork in the road" venue choices (v19)
--
-- Real-venue stops previously went straight from "unrevealed placeholder"
-- to "auto-picked and committed." This adds a middle state: a stop can now
-- sit with a set of OFFERED (not yet committed) candidates, so the player
-- sees 3 contrasting real venues and picks one — a "choose your own
-- adventure" fork — instead of the game silently deciding for them.
--
-- candidate_pool (0016) keeps its existing role as "the full remaining
-- pool for this stop" (used to draw fresh choices on reroll). This new
-- column is the specific subset currently being presented to the player.
alter table route_stops
  add column if not exists offered_choices jsonb;
