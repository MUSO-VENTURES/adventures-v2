-- MUSO Adventures — Participant profile page, phase 1 (v9)
--
-- Foundation for the profile page: avatar upload, bio, anniversary date, a
-- flexible preferences blob, and two Storage buckets (avatars, photobooth).
-- Everything else the profile page shows (coins, level/xp, unlocked radius,
-- leaderboard placement, photobooth check-in photos) already exists in
-- 0001_init.sql / 0007_gamification.sql — this migration only adds what's
-- genuinely new.
--
-- Safe to run once, after 0008_themes.sql.

-- ---------------------------------------------------------------
-- profiles: new editable fields
-- ---------------------------------------------------------------

alter table profiles
  add column if not exists avatar_url text,
  add column if not exists anniversary_date date,
  add column if not exists bio text,
  add column if not exists preferences jsonb not null default '{}'::jsonb;

-- Same sanity bound already used on birth_date in 0006_birthday_capture.sql —
-- stops an obvious typo (e.g. year 2125) without blocking legitimately old
-- anniversaries. NOT VALID: only enforced on new/updated rows.
alter table profiles
  drop constraint if exists profiles_anniversary_date_range_check;
alter table profiles
  add constraint profiles_anniversary_date_range_check
  check (
    anniversary_date is null
    or (anniversary_date <= current_date and anniversary_date >= current_date - interval '120 years')
  )
  not valid;

-- Keep bio to a sane length so it can't be used to stuff arbitrary amounts
-- of text into a profile row.
alter table profiles
  drop constraint if exists profiles_bio_length_check;
alter table profiles
  add constraint profiles_bio_length_check check (bio is null or char_length(bio) <= 500);

-- No new RLS policy needed: "user updates own profile" from 0001_init.sql
-- already covers every column on a player's own row via auth.uid() = id,
-- and avatar_url/anniversary_date/bio/preferences aren't in the revoke
-- list from 0007_gamification.sql (that list is xp/adventure_coins/
-- unlocked_radius_miles/venues_search_unlocked only — the gameplay-sensitive
-- columns). So these new fields are client-editable by design, same as
-- display_name/avatar_color/phone already were.

-- ---------------------------------------------------------------
-- Storage buckets: avatars + photobooth
-- ---------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('avatars', 'avatars', true)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('photobooth', 'photobooth', true)
on conflict (id) do nothing;

-- Both buckets are public-read (profile pictures and shareable adventure
-- photos are meant to be seen — check_ins already has a
-- shared_to_social flag suggesting these were always meant to be
-- shareable). Writes are restricted to the owner via a folder-prefix
-- convention: the first path segment of every uploaded object must be the
-- uploader's own auth.uid(), e.g. avatars/<user-id>/profile.jpg or
-- photobooth/<user-id>/<check-in-id>.jpg.

drop policy if exists "avatar images are publicly readable" on storage.objects;
create policy "avatar images are publicly readable" on storage.objects
  for select using (bucket_id = 'avatars');

drop policy if exists "users upload their own avatar" on storage.objects;
create policy "users upload their own avatar" on storage.objects
  for insert with check (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users update their own avatar" on storage.objects;
create policy "users update their own avatar" on storage.objects
  for update using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users delete their own avatar" on storage.objects;
create policy "users delete their own avatar" on storage.objects
  for delete using (
    bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "photobooth images are publicly readable" on storage.objects;
create policy "photobooth images are publicly readable" on storage.objects
  for select using (bucket_id = 'photobooth');

drop policy if exists "users upload their own photobooth photos" on storage.objects;
create policy "users upload their own photobooth photos" on storage.objects
  for insert with check (
    bucket_id = 'photobooth' and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "users delete their own photobooth photos" on storage.objects;
create policy "users delete their own photobooth photos" on storage.objects
  for delete using (
    bucket_id = 'photobooth' and (storage.foldername(name))[1] = auth.uid()::text
  );

-- ---------------------------------------------------------------
-- Leaderboard placement for the calling profile
-- ---------------------------------------------------------------

-- The `leaderboard` view (0001_init.sql) is built on top of parties/
-- party_members/adventures/check_ins, all of which are RLS-restricted to
-- "members read their own party" — so a plain SELECT against the view from
-- a regular player only ever returns their own party's row, never enough
-- to compute a real rank. This mirrors the existing is_party_member() /
-- is_party_owner() pattern from 0001_init.sql: a SECURITY DEFINER function
-- runs as the function owner and so isn't subject to the calling role's
-- RLS, letting it safely compare across all parties while only ever
-- returning the caller's own rank/party name — never other parties' names
-- or details — back to the client.
create or replace function public.my_leaderboard_rank()
returns jsonb
language plpgsql
security definer
set search_path = public
stable
as $func$
declare
  v_party_id uuid;
  v_party_name text;
  v_adventures int;
  v_stops int;
  v_rank int;
  v_total int;
begin
  select p.id, p.name into v_party_id, v_party_name
  from party_members pm
  join parties p on p.id = pm.party_id
  where pm.profile_id = auth.uid()
  order by pm.joined_at asc
  limit 1;

  if v_party_id is null then
    return jsonb_build_object('inParty', false);
  end if;

  select adventures_completed, stops_checked_in into v_adventures, v_stops
  from leaderboard where party_id = v_party_id;

  select count(*) + 1 into v_rank
  from leaderboard
  where (adventures_completed, stops_checked_in) > (v_adventures, v_stops);

  select count(*) into v_total from leaderboard;

  return jsonb_build_object(
    'inParty', true,
    'partyName', v_party_name,
    'rank', v_rank,
    'totalParties', v_total,
    'adventuresCompleted', coalesce(v_adventures, 0),
    'stopsCheckedIn', coalesce(v_stops, 0)
  );
end;
$func$;

grant execute on function public.my_leaderboard_rank() to authenticated;
