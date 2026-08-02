-- Seeds lat/lng on the demo "After Hours" route's venues (see 0002_seed.sql)
-- so the itinerary progress map (pin at the stop you just checked into,
-- path to the next stop, new pin there) has real coordinates to plot.
-- venues.lat/lng already existed (0001_init.sql) for the real-venue search
-- flow — this just backfills them for the curated-route demo venues, which
-- were seeded without coordinates. Matched by name since 0002_seed.sql
-- doesn't capture the generated venue ids into named variables reusable
-- here. Safe to run more than once (idempotent UPDATEs).

update venues set lat = 37.6805, lng = -121.7695 where name = 'Riverside Axe House';
update venues set lat = 37.6819, lng = -121.7680 where name = 'Late-Night Noodle Spot';
update venues set lat = 37.6830, lng = -121.7660 where name = 'Neon Karaoke Bar';
update venues set lat = 37.6795, lng = -121.7645 where name = 'Corner Store';
update venues set lat = 37.6870, lng = -121.7550 where name = 'Sunrise Lookout';
