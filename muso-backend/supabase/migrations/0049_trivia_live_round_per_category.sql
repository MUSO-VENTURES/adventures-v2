-- MUSO Adventures — scope Trivia Break's "one live round" constraint per category (v49)
--
-- Same root issue as 0048, one layer deeper: idx_trivia_rounds_one_live_
-- group/solo (0047_trivia_freeplay.sql) enforce "at most one live round"
-- per (party, adventure, mode) — not per category. So switching categories
-- while a round in the OLD category was still live ('buzzing'/'answering',
-- e.g. the player never finished it) hit the unique index on the INSERT,
-- and startRound's conflict-fallback (fetchLiveRound) handed back that
-- stale OTHER-category round instead of starting the newly-requested one —
-- confirmed locally: requesting 'dogs' while a 'wtf' round was still live
-- silently returned the 'wtf' round.
--
-- Scoping by category too lets a player abandon a live round by switching
-- categories (the old one just sits there until someone resumes or times
-- it out via advanceTurn, same as abandoning it any other way already
-- behaved) instead of being trapped on it.

drop index if exists idx_trivia_rounds_one_live_group;
create unique index idx_trivia_rounds_one_live_group
  on trivia_rounds(party_id, coalesce(adventure_id, '00000000-0000-0000-0000-000000000000'::uuid), category)
  where status in ('buzzing', 'answering') and mode = 'group';

drop index if exists idx_trivia_rounds_one_live_solo;
create unique index idx_trivia_rounds_one_live_solo
  on trivia_rounds(party_id, coalesce(adventure_id, '00000000-0000-0000-0000-000000000000'::uuid), initiator_profile_id, category)
  where status in ('buzzing', 'answering') and mode = 'solo';
