-- MUSO Adventures — Three-tier search radius (v12)
--
-- Replaces the old flat "25mi free / 100mi unlocked" radius model
-- (0007_gamification.sql) with three tiers:
--
--   1. Free / default   — up to 30 miles. Every profile starts here.
--      The search UI itself defaults its slider position to 15 miles
--      (a friendlier starting point), but the account-level cap enforced
--      by venues-search/unlock-feature is 30.
--   2. Self-serve unlock — up to 50 miles. Reached via unlock-feature's
--      'radius' path, same as before: free once the player hits the
--      relevant level, or purchasable with Adventure Coins.
--   3. Exclusive         — up to 100 miles. NOT available through any
--      self-serve unlock — this is a manual grant for hand-picked
--      participants (e.g. `update profiles set unlocked_radius_miles = 100
--      where id = '<uuid>'` run by MUSO staff in the SQL Editor). There is
--      deliberately no coin price or level threshold for this tier in the
--      app code.
--
-- unlocked_radius_miles remains the single source of truth for all three
-- tiers — the tier a profile is "in" is just whichever of 30/50/100 is <=
-- its current value. No new column needed.

alter table profiles
  alter column unlocked_radius_miles set default 30;

-- Bump anyone still sitting at the old free default (25) up to the new one
-- (30). Deliberately scoped to exactly 25 so this never touches a profile
-- that already paid/leveled up to the old 100mi unlock, or any exclusive
-- grant — only rows nobody has ever upgraded get moved.
update profiles
  set unlocked_radius_miles = 30
  where unlocked_radius_miles = 25;

-- Tighten the ceiling to 100 (the new exclusive-tier cap) now that nothing
-- in the app ever needs to set higher than that.
alter table profiles
  drop constraint if exists profiles_radius_range;
alter table profiles
  add constraint profiles_radius_range check (unlocked_radius_miles between 30 and 100);
