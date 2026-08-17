-- MUSO Adventures — backfill Trivia Break unlock for existing players (v42)
--
-- checkin/index.ts only unlocks 'trivia' at the exact moment a check-in
-- becomes someone's FIRST ever (isFirstCheckin) — correct for every new
-- signup going forward, but it does nothing for a player who already
-- passed that milestone before Trivia Break existed. Confirmed on the live
-- project: smusseau@gmail.com (22 check-ins) and smusseau.ventures@gmail.com
-- (2 check-ins) both have zero 'trivia' row in profile_minigames, while
-- smusseau.jobs@gmail.com (0 check-ins) is correctly still locked and will
-- unlock normally on their real first check-in.
--
-- Trivia Break is meant to be the very first reward that engages a player,
-- so this one-time backfill grants it to every profile that already has at
-- least one check-in but hasn't been granted it yet — same
-- unlocked_via:'first_checkin' value checkin/index.ts uses, since for
-- these players their (already-past) first check-in is exactly the event
-- this retroactively credits.

insert into profile_minigames (profile_id, minigame_key, unlocked_via)
select distinct ci.checked_in_by, 'trivia', 'first_checkin'
from check_ins ci
where not exists (
  select 1 from profile_minigames pm
  where pm.profile_id = ci.checked_in_by and pm.minigame_key = 'trivia'
)
on conflict (profile_id, minigame_key) do nothing;
