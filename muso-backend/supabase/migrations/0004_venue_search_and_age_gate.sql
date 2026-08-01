-- MUSO Adventures — Yelp venue search dedup + age gate / disclaimer
-- acknowledgment (v1.2). Safe to run once after 0003_venues_and_radius.sql.

-- =========================================================
-- VENUE DEDUP (for the venues-search edge function, which upserts
-- Yelp results keyed by yelp_id so repeated searches don't create
-- duplicate rows for the same real-world business)
-- =========================================================

alter table venues
  add column if not exists yelp_id text unique;

-- =========================================================
-- AGE GATE + LIABILITY DISCLAIMER ACKNOWLEDGMENT
--
-- Self-attestation, captured at the point of the discovery form (which is
-- often filled out before an account exists). age_confirmed is only
-- required when content_rating is NC-17 or Adults Only; disclaimer_accepted
-- is required on every submission regardless of content rating, since
-- routes can involve alcohol and physical activities at any rating level.
-- =========================================================

alter table discovery_responses
  add column if not exists age_confirmed boolean not null default false,
  add column if not exists disclaimer_accepted boolean not null default false,
  add column if not exists disclaimer_accepted_at timestamptz;

-- NOT VALID: enforce on every new/updated row going forward, without
-- requiring pre-existing rows (from testing, before this column existed)
-- to retroactively satisfy a consent they were never actually asked for.
alter table discovery_responses
  drop constraint if exists discovery_responses_age_gate_check;
alter table discovery_responses
  add constraint discovery_responses_age_gate_check
  check (content_rating not in ('NC-17', 'Adults Only') or age_confirmed = true)
  not valid;

alter table discovery_responses
  drop constraint if exists discovery_responses_disclaimer_check;
alter table discovery_responses
  add constraint discovery_responses_disclaimer_check
  check (disclaimer_accepted = true)
  not valid;

-- Persistent record on signed-up accounts too, so returning players aren't
-- forced through the gate on every single discovery submission once
-- they're logged in (the client can check this and skip re-showing the
-- gate; discovery-submit itself still requires the flags on each request).
alter table profiles
  add column if not exists age_confirmed_at timestamptz,
  add column if not exists disclaimer_accepted_at timestamptz;
