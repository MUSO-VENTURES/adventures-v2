-- MUSO Adventures — real birthday capture (v1.4). Safe to run once after
-- 0005_venue_photos.sql.
--
-- Replaces the old click-through "I am 18+" self-attestation checkbox with
-- an actual date of birth, captured once at the entry gate. This lets us:
--   1. Compute a real age instead of trusting an unverified checkbox, and
--   2. Reuse that birthday for promotional purposes (birthday specials).
--
-- age_confirmed / age_confirmed_at are kept (now computed server-side from
-- birth_date in discovery-submit) so the existing CHECK constraint from
-- 0004 keeps working unchanged.

alter table discovery_responses
  add column if not exists birth_date date;

alter table profiles
  add column if not exists birth_date date;

-- Lightweight sanity bound so a typo (e.g. year 2125) can't silently defeat
-- the age gate. NOT VALID: enforced on new/updated rows only, existing test
-- rows (which predate this column and are therefore null) aren't affected.
alter table discovery_responses
  drop constraint if exists discovery_responses_birth_date_range_check;
alter table discovery_responses
  add constraint discovery_responses_birth_date_range_check
  check (
    birth_date is null
    or (birth_date <= current_date and birth_date >= current_date - interval '120 years')
  )
  not valid;

alter table profiles
  drop constraint if exists profiles_birth_date_range_check;
alter table profiles
  add constraint profiles_birth_date_range_check
  check (
    birth_date is null
    or (birth_date <= current_date and birth_date >= current_date - interval '120 years')
  )
  not valid;

-- =========================================================
-- GATE SIGNUPS (birthday capture at site entry, for promo use)
--
-- Captured once per browser when someone passes the entry gate — separate
-- from discovery_responses because the gate happens before anyone has
-- necessarily filled out a discovery form. Contains PII (email, birth_date),
-- so RLS is enabled with no public policies: only the service-role key
-- (used by the gate-capture edge function) can read or write it.
-- =========================================================

create table if not exists gate_signups (
  id uuid primary key default gen_random_uuid(),
  birth_date date not null,
  email text,
  disclaimer_accepted boolean not null default false,
  disclaimer_accepted_at timestamptz,
  created_at timestamptz not null default now()
);

alter table gate_signups enable row level security;

alter table gate_signups
  drop constraint if exists gate_signups_birth_date_range_check;
alter table gate_signups
  add constraint gate_signups_birth_date_range_check
  check (birth_date <= current_date and birth_date >= current_date - interval '120 years');
