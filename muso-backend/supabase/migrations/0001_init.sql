-- MUSO Adventures — Core schema (v1)
-- Postgres / Supabase. Run via `supabase db push` or the SQL editor.

create extension if not exists "pgcrypto";

-- =========================================================
-- ACCOUNTS
-- =========================================================

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_color text default '#ff6b6b',
  phone text,
  is_premium boolean not null default false,
  created_at timestamptz not null default now()
);

-- A "party" is the couple/crew/team playing together. Adventures, check-ins
-- and leaderboard stats are tracked per party, not per individual user,
-- since MUSO is played in groups.
create table if not exists parties (
  id uuid primary key default gen_random_uuid(),
  name text not null,                 -- e.g. "Jordan & Alex"
  created_by uuid not null references profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists party_members (
  party_id uuid not null references parties(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner','member')),
  joined_at timestamptz not null default now(),
  primary key (party_id, profile_id)
);

-- =========================================================
-- VENUES (also doubles as the business/owner directory)
-- =========================================================

create table if not exists venues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text,                      -- 'wine bar', 'axe throwing', etc.
  address text,
  lat numeric(9,6),
  lng numeric(9,6),
  partner_tier text not null default 'basic' check (partner_tier in ('basic','premium','sponsor')),
  created_at timestamptz not null default now()
);

-- A venue can have multiple owner/manager contacts who want the
-- "players are heading your way" heads-up. At least one should be marked primary.
create table if not exists venue_contacts (
  id uuid primary key default gen_random_uuid(),
  venue_id uuid not null references venues(id) on delete cascade,
  contact_name text,
  email text,
  phone text,
  notify_by text not null default 'email' check (notify_by in ('email','sms','both')),
  is_primary boolean not null default true,
  created_at timestamptz not null default now(),
  constraint venue_contacts_has_channel check (email is not null or phone is not null)
);

create index if not exists idx_venue_contacts_venue on venue_contacts(venue_id);

-- =========================================================
-- ROUTES (moods -> twists -> stop sequence)
-- =========================================================

create table if not exists moods (
  key text primary key,               -- 'cozy' | 'adventurous' | 'spontaneous'
  label text not null,
  emoji text
);

create table if not exists twists (
  key text primary key,               -- 'cozy-candlelit', 'adv-dark', ...
  mood_key text not null references moods(key) on delete cascade,
  label text not null,
  emoji text
);

create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  twist_key text not null references twists(key),
  title text not null,                -- "The Slow Burn"
  description text,
  stop_count_options int[] not null default '{2,3,4,5}',
  is_sponsored boolean not null default false,
  sponsor_venue_id uuid references venues(id),
  created_at timestamptz not null default now()
);

-- Ordered stops within a route. `stop_order` starting at 1 defines the
-- sequence used both for the itinerary reveal and for "notify the next venue".
create table if not exists route_stops (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id) on delete cascade,
  venue_id uuid references venues(id),   -- null allowed for "mystery stop" until revealed
  stop_order int not null,
  name text not null,
  description text,
  emoji text,
  is_mystery boolean not null default false,
  game_prep_notes text,                  -- e.g. "ask for the escape room booking under MUSO"
  unique (route_id, stop_order)
);

create index if not exists idx_route_stops_route on route_stops(route_id, stop_order);

-- =========================================================
-- ADVENTURES (an instance of a party playing a route)
-- =========================================================

create table if not exists adventures (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  route_id uuid not null references routes(id),
  stop_count int not null,
  status text not null default 'in_progress' check (status in ('in_progress','completed','abandoned')),
  started_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_adventures_party on adventures(party_id);

create table if not exists check_ins (
  id uuid primary key default gen_random_uuid(),
  adventure_id uuid not null references adventures(id) on delete cascade,
  route_stop_id uuid not null references route_stops(id),
  checked_in_by uuid not null references profiles(id) on delete cascade,
  photo_url text,
  shared_to_social boolean not null default false,
  checked_in_at timestamptz not null default now(),
  unique (adventure_id, route_stop_id)
);

create index if not exists idx_checkins_adventure on check_ins(adventure_id);

-- Log of "heads up, players are coming" notifications sent to venue owners,
-- so we don't double-send and can show delivery status / debug failures.
create table if not exists venue_notifications (
  id uuid primary key default gen_random_uuid(),
  adventure_id uuid not null references adventures(id) on delete cascade,
  route_stop_id uuid not null references route_stops(id),
  venue_contact_id uuid references venue_contacts(id),
  channel text not null check (channel in ('email','sms')),
  party_size int,
  eta_minutes int,
  game_prep_notes text,
  status text not null default 'pending' check (status in ('pending','sent','failed','skipped_no_contact')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);

create index if not exists idx_venue_notifications_adventure on venue_notifications(adventure_id);

-- =========================================================
-- DISCOVERY FORM
-- =========================================================

create table if not exists discovery_responses (
  id uuid primary key default gen_random_uuid(),
  party_id uuid references parties(id) on delete set null,
  mode text not null default 'quick' check (mode in ('quick','full')),
  budget text check (budget in ('$','$$','$$$','$$$$')),
  content_rating text check (content_rating in ('G-Rated','PG-Rated','NC-17','Adults Only')),
  alcohol_pref text check (alcohol_pref in ('Alcohol-Friendly','Sober / Alcohol-Free')),
  interests text[],
  occasion text,
  group_size int,
  notes text,
  created_at timestamptz not null default now()
);

-- =========================================================
-- REWARDS / MILESTONES
-- =========================================================

create table if not exists reward_tiers (
  id uuid primary key default gen_random_uuid(),
  track text not null check (track in ('explorer','vip')),
  milestone_adventures int not null,
  reward_text text not null
);

create table if not exists reward_redemptions (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  reward_tier_id uuid not null references reward_tiers(id),
  redeemed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (party_id, reward_tier_id)
);

-- =========================================================
-- LEADERBOARD (computed view, cheap to query at scale via indexes above)
-- =========================================================

create or replace view leaderboard as
select
  p.id as party_id,
  p.name as party_name,
  count(distinct a.id) filter (where a.status = 'completed') as adventures_completed,
  count(distinct c.id) as stops_checked_in,
  max(a.completed_at) as last_adventure_at
from parties p
left join adventures a on a.party_id = p.id
left join check_ins c on c.adventure_id = a.id
group by p.id, p.name;

-- =========================================================
-- ROW LEVEL SECURITY
-- =========================================================

alter table profiles enable row level security;
alter table parties enable row level security;
alter table party_members enable row level security;
alter table adventures enable row level security;
alter table check_ins enable row level security;
alter table discovery_responses enable row level security;
alter table reward_redemptions enable row level security;
alter table venue_notifications enable row level security;

-- Reference/content tables (venues, routes, moods, twists, route_stops,
-- reward_tiers) are readable by anyone signed in — no player data in them.
alter table venues enable row level security;
alter table routes enable row level security;
alter table route_stops enable row level security;
alter table moods enable row level security;
alter table twists enable row level security;
alter table reward_tiers enable row level security;

create policy "content readable by authenticated" on venues for select using (auth.role() = 'authenticated');
create policy "content readable by authenticated" on routes for select using (auth.role() = 'authenticated');
create policy "content readable by authenticated" on route_stops for select using (auth.role() = 'authenticated');
create policy "content readable by authenticated" on moods for select using (auth.role() = 'authenticated');
create policy "content readable by authenticated" on twists for select using (auth.role() = 'authenticated');
create policy "content readable by authenticated" on reward_tiers for select using (auth.role() = 'authenticated');

create policy "user reads own profile" on profiles for select using (auth.uid() = id);
create policy "user updates own profile" on profiles for update using (auth.uid() = id);
create policy "user inserts own profile" on profiles for insert with check (auth.uid() = id);

create policy "members read their party" on parties for select using (
  exists (select 1 from party_members m where m.party_id = parties.id and m.profile_id = auth.uid())
);
create policy "members create a party" on parties for insert with check (auth.uid() = created_by);

-- party_members policies can't subquery party_members directly inside their
-- own USING/CHECK clause — Postgres re-evaluates the same RLS policy for
-- that inner query and recurses infinitely ("infinite recursion detected in
-- policy for relation party_members"). Route the membership check through a
-- SECURITY DEFINER function instead, which runs as the function owner and
-- so isn't subject to the calling role's RLS on party_members.
create or replace function is_party_member(target_party_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $func$
  select exists (
    select 1 from party_members
    where party_id = target_party_id and profile_id = auth.uid()
  );
$func$;

create or replace function is_party_owner(target_party_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $func$
  select exists (
    select 1 from party_members
    where party_id = target_party_id and profile_id = auth.uid() and role = 'owner'
  );
$func$;

create or replace function party_has_no_members(target_party_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $func$
  select not exists (
    select 1 from party_members where party_id = target_party_id
  );
$func$;

create policy "members read party_members rows for their party" on party_members for select using (
  is_party_member(party_id)
);
create policy "owner adds party members" on party_members for insert with check (
  is_party_owner(party_id) or party_has_no_members(party_id)
);

create policy "members read own adventures" on adventures for select using (
  exists (select 1 from party_members m where m.party_id = adventures.party_id and m.profile_id = auth.uid())
);
create policy "members create adventures" on adventures for insert with check (
  exists (select 1 from party_members m where m.party_id = adventures.party_id and m.profile_id = auth.uid())
);

create policy "members read own check-ins" on check_ins for select using (
  exists (
    select 1 from adventures a
    join party_members m on m.party_id = a.party_id
    where a.id = check_ins.adventure_id and m.profile_id = auth.uid()
  )
);
create policy "members create own check-ins" on check_ins for insert with check (
  checked_in_by = auth.uid()
  and exists (
    select 1 from adventures a
    join party_members m on m.party_id = a.party_id
    where a.id = check_ins.adventure_id and m.profile_id = auth.uid()
  )
);

create policy "anyone can submit discovery form" on discovery_responses for insert with check (true);
create policy "members read own discovery responses" on discovery_responses for select using (
  party_id is null or exists (select 1 from party_members m where m.party_id = discovery_responses.party_id and m.profile_id = auth.uid())
);

create policy "members read own redemptions" on reward_redemptions for select using (
  exists (select 1 from party_members m where m.party_id = reward_redemptions.party_id and m.profile_id = auth.uid())
);

-- venue_notifications contains no player PII beyond a headcount, but it's
-- operational data — restrict reads to members of the adventure that
-- triggered the notification. All writes happen from the edge function
-- using the service role key, which bypasses RLS.
create policy "members read own venue notifications" on venue_notifications for select using (
  exists (
    select 1 from adventures a
    join party_members m on m.party_id = a.party_id
    where a.id = venue_notifications.adventure_id and m.profile_id = auth.uid()
  )
);
