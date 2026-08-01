-- Content for the Roku-style parallax scene on the home screen (see
-- /parallax-concept.html). Each row is one "storefront" building in the
-- foreground layer. Deliberately editable straight from the Supabase Table
-- Editor with no code deploy: add/reorder/hide a row and the scene picks it
-- up on next load. x-position is computed client-side from sort_order +
-- width, same reasoning as 0008_themes.sql ("no migration required to add
-- content") — nobody managing this table should have to do coordinate math.

create table if not exists public.parallax_stops (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  emoji text not null,
  -- Index into the day/night building color palette (PALETTES.building[]
  -- in parallax-concept.html), not a hex value, so re-theming the scene
  -- doesn't require touching every row.
  color_index integer not null default 0,
  width integer not null default 130,
  height integer not null default 150,
  is_big boolean not null default false,
  sort_order integer not null default 0,
  -- Where tapping this storefront should take the player. Left null for
  -- stops that are still concept-only / not wired to a real section yet.
  link_url text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

alter table public.parallax_stops enable row level security;

drop policy if exists "parallax stops are publicly readable" on public.parallax_stops;
create policy "parallax stops are publicly readable" on public.parallax_stops
  for select using (is_active = true);

-- Same defense-in-depth pattern as profile_theme_unlocks in 0008_themes.sql:
-- the anon/authenticated client can read this table but never write to it.
-- Editing happens outside the app — via the Supabase dashboard's Table
-- Editor or SQL — which is the whole point of this table.
revoke insert, update, delete on public.parallax_stops from authenticated, anon;

insert into public.parallax_stops (label, emoji, color_index, width, height, is_big, sort_order, link_url, is_active)
values
  ('DISCOVERY\nBASE',     '🔍', 0, 130, 150, false, 10, null, true),
  ('MAPS & GEAR',         '🗺️', 1, 120, 130, false, 20, null, true),
  ('EXPEDITION\nCENTRAL', '🎉', 2, 220, 210, true,  30, null, true),
  ('REWARDS\nOUTPOST',    '🪙', 3, 140, 150, false, 40, null, true),
  ('LEADERBOARD\nLOUNGE', '🏆', 0, 150, 150, false, 50, null, true)
on conflict do nothing;
