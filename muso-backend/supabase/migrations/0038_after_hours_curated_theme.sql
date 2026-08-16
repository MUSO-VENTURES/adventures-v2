-- MUSO Adventures — retroactively theme the seeded "After Hours" curated route (v38)
--
-- The demo curated route seeded in 0002_seed.sql (twist_key 'adv-dark',
-- title 'After Hours') predates both the venue_theme column
-- (0022_wine_country_adventure.sql) and the real-venue After Hours theme
-- built later, so it never got venue_theme = 'after_hours' — meaning the
-- frontend's past-adventures list (which looks up icon/accent color by
-- venue_theme) fell back to a plain emoji for it instead of the same
-- themed art everywhere else "After Hours" appears. This is purely a
-- display lookup; real-venue-adventure/index.ts's advance/reroll actions
-- only ever run for mode = 'real_venue' adventures, so backfilling this on
-- a curated route has no effect on gameplay.

update routes
set venue_theme = 'after_hours'
where twist_key = 'adv-dark' and title = 'After Hours' and venue_theme is null;
