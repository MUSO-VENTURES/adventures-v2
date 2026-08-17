-- MUSO Adventures — rename Furry Friends -> dogs, retheme content (v45)
--
-- "Furry Friends" was pulled from Open Trivia Database's generic "Animals"
-- category (seahorses, newts, vultures, tarantulas...) — almost none of it
-- was actually about dogs, despite dog_friendly-themed adventures mapping
-- to it. Renamed to a dedicated 'dogs' category with an all-new,
-- strictly K9-only question bank (see _shared/triviaGenerator.ts). Great
-- Outdoors and Curiosities got the same content-fidelity pass — Great
-- Outdoors had drifted into generic world-capitals trivia (Bucharest,
-- Ankara, Slovakia's capital...) with nothing about hiking, trails, or
-- nature; Curiosities read as a chemistry-class quiz (SI units, periodic
-- table groups, mitosis phases) rather than the "curiosity shop / weird
-- museum / a little strange in a good way" spirit the Oddities adventure
-- theme actually describes. Both were replaced with on-theme content;
-- their category KEY didn't change, only their bank contents did, so no
-- data migration is needed for those two — only the furry_friends -> dogs
-- rename touches existing rows.
--
-- 14 real trivia_rounds rows already exist with category='furry_friends'
-- from actual gameplay since Trivia Break shipped — updated in place
-- rather than left as a permanently-orphaned legacy value, since this is a
-- true rename (same real-world category, new key/name), not a removal.

-- Three-step dance, not two — a straight swap to a 'dogs'-only constraint
-- fails no matter which side of the UPDATE it runs on: doing it after the
-- UPDATE rejects the UPDATE itself (old constraint doesn't allow 'dogs'
-- yet — this is what the actual `supabase db push` against production
-- caught, failing cleanly in a transaction with zero rows changed).
-- Doing it before the UPDATE instead just moves the failure earlier: ADD
-- CONSTRAINT validates every EXISTING row immediately, and the 14 rows
-- still sitting at 'furry_friends' at that point would violate a
-- 'dogs'-only constraint just as fast. So: widen first (allow both old
-- and new value), migrate the data, then narrow to the final set.
alter table trivia_rounds
  drop constraint if exists trivia_rounds_category_check;
alter table trivia_rounds
  add constraint trivia_rounds_category_check
  check (category in ('furry_friends', 'dogs', 'great_outdoors', 'curiosities', 'food_for_thought', 'after_hours', 'wtf'));

update trivia_rounds set category = 'dogs' where category = 'furry_friends';

alter table trivia_rounds
  drop constraint if exists trivia_rounds_category_check;
alter table trivia_rounds
  add constraint trivia_rounds_category_check
  check (category in ('dogs', 'great_outdoors', 'curiosities', 'food_for_thought', 'after_hours', 'wtf'));
