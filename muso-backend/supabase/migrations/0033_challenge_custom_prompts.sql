-- MUSO Adventures — custom prompts on coin flip challenges (v33)
--
-- Lets a challenger name their own flip ("Who gets a back rub?", "Second
-- date?") instead of always seeing the generic "X vs Y" heading — see
-- 0032_coin_flip_challenges.sql for the rest of the challenge model. Free
-- text, so it's stored as typed; the real content gate (PG-13 profanity/
-- abuse block) lives in minigames/index.ts's 'challenge' action, not here —
-- a CHECK constraint can't run the same wordlist logic an edge function
-- can, and the edge function is the only thing that ever writes this
-- column anyway (no direct-insert policy on this table, same as the rest
-- of it). The 200-char cap is just a sanity bound against a wall of text
-- blowing out the challenge-send modal's layout.

alter table coin_flip_challenges
  add column if not exists prompt text check (char_length(prompt) <= 200);
