-- MUSO Adventures — real-time heads/tails race pick for coin flip challenges (v37)
--
-- Reworks coin_flip_challenges so the challenger no longer locks in a side
-- up front. Instead, both players see an open "pick heads or tails" race
-- once a challenge is sent, and whichever pick reaches the server first is
-- the one that sticks — the other side is forced onto the other player.
-- The pick and the flip resolution now happen together, server-side, in
-- minigames/index.ts's new pickSide action (see that file's top comment).
--
-- challenger_call keeps its existing name (renaming would touch every
-- query already written against it) but now means "whichever side got
-- locked in first," not "the challenger's side" — first_picker_id records
-- which of the two players that actually was, so the winner can still be
-- computed correctly regardless of who won the race.

alter table coin_flip_challenges
  alter column challenger_call drop not null;

alter table coin_flip_challenges
  add column if not exists first_picker_id uuid references profiles(id) on delete set null;
