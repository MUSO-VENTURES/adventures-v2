-- MUSO Adventures — Trivia Break game-end summary (v46)
--
-- Adds the recap players see at the end of each 5-question game: the
-- actual list of questions asked plus whether each was answered correctly,
-- not just the bare correct-count trivia_rounds.game_correct_count already
-- carried. Stored as JSON on the game-ending round itself (same as
-- game_correct_count/game_leveled_up/game_new_difficulty from
-- 0044_trivia_games_and_leveling.sql) so it fans out to every party member
-- via the existing trivia_rounds realtime subscription, not just whoever
-- answered last.

alter table trivia_rounds
  add column if not exists game_summary jsonb;
