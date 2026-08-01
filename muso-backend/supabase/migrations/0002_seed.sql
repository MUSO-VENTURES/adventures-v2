-- Seed data mirroring the landing page's sample content (moods, twists,
-- one full route with stops, and the Explorer/VIP reward tracks). Safe to
-- run once after 0001_init.sql. Uses fixed keys/on-conflict so it's
-- re-runnable without creating duplicates.

insert into moods (key, label, emoji) values
  ('cozy', 'Cozy', '🍸'),
  ('adventurous', 'Adventurous', '🎯'),
  ('spontaneous', 'Spontaneous', '🎲')
on conflict (key) do nothing;

insert into twists (key, mood_key, label, emoji) values
  ('cozy-candlelit', 'cozy', 'Candlelit', '🕯️'),
  ('cozy-bookish', 'cozy', 'Bookish', '📖'),
  ('adv-stakes', 'adventurous', 'High-stakes', '🪓'),
  ('adv-dark', 'adventurous', 'After dark', '🌙'),
  ('spo-surprise', 'spontaneous', 'Surprise me', '🎁'),
  ('spo-food', 'spontaneous', 'Foodie roulette', '🍜')
on conflict (key) do nothing;

-- One fully-built sample route: "After Hours" (adv-dark), matching the
-- landing page demo, wired up to real venues so the check-in +
-- venue-notification flow can be tested end to end.
do $$
declare
  v_axe uuid;
  v_noodle uuid;
  v_karaoke uuid;
  v_store uuid;
  v_lookout uuid;
  v_route uuid;
begin
  insert into venues (name, category, partner_tier) values ('Riverside Axe House', 'axe throwing', 'premium') returning id into v_axe;
  insert into venues (name, category, partner_tier) values ('Late-Night Noodle Spot', 'food & drink', 'basic') returning id into v_noodle;
  insert into venues (name, category, partner_tier) values ('Neon Karaoke Bar', 'nightlife', 'premium') returning id into v_karaoke;
  insert into venues (name, category, partner_tier) values ('Corner Store', 'shopping', 'basic') returning id into v_store;
  insert into venues (name, category, partner_tier) values ('Sunrise Lookout', 'outdoors', 'basic') returning id into v_lookout;

  insert into venue_contacts (venue_id, contact_name, email, notify_by, is_primary)
  values
    (v_axe, 'Riverside Axe House Manager', 'manager@riversideaxehouse.example', 'email', true),
    (v_noodle, 'Noodle Spot Owner', 'owner@latenightnoodle.example', 'email', true),
    (v_karaoke, 'Neon Karaoke Host', 'host@neonkaraoke.example', 'email', true);
    -- Corner Store and Sunrise Lookout intentionally have no contact on file
    -- yet, to exercise the "skipped_no_contact" path.

  insert into routes (twist_key, title, description) values
    ('adv-dark', 'After Hours', 'Burn off the pre-date nerves, then chase the night until sunrise.') returning id into v_route;

  insert into route_stops (route_id, venue_id, stop_order, name, description, emoji, game_prep_notes) values
    (v_route, v_axe, 1, 'Axe Throwing', 'Burn off the pre-date nerves.', '🪓', 'Ask for the MUSO Adventures lane booking; two throwers per stall.'),
    (v_route, v_noodle, 2, 'Late-Night Noodle Spot', 'Only good after 9pm anyway.', '🍜', 'Group usually orders the combo platter — have menus ready.'),
    (v_route, v_karaoke, 3, 'Karaoke Bar', 'One song each, no excuses.', '🎤', 'Reserve a small private room if available.'),
    (v_route, v_store, 4, 'Corner Store Run', 'Snacks for the walk home.', '🏪', null),
    (v_route, v_lookout, 5, 'Sunrise Lookout', 'Catch the first light from the best view in town.', '🌅', null);
end $$;

insert into reward_tiers (track, milestone_adventures, reward_text) values
  ('explorer', 3, 'Free appetizer at a partner venue on your next stop.'),
  ('explorer', 5, 'One bonus route unlocked, on the house.'),
  ('explorer', 10, '"Explorer" badge on the leaderboard + early access to new routes.'),
  ('explorer', 15, 'Free entry to a sponsored route of your choice.'),
  ('vip', 3, 'Free appetizer and dessert at a partner venue.'),
  ('vip', 5, 'Two bonus routes unlocked free.'),
  ('vip', 10, '"VIP Explorer" badge + priority booking at premium venues.'),
  ('vip', 15, 'A full sponsored date night for two, transportation included.');
