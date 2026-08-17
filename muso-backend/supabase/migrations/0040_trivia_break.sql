-- MUSO Adventures — Trivia Break minigame (v40)
--
-- Solo or group ("quick draw" buzzer) trivia generated from a party's
-- current route content (route_stops/venues/venue_reviews) via template
-- generation (see _shared/triviaGenerator.ts) — no LLM call, works
-- instantly for any adventure, curated or real-venue, without per-
-- adventure hardcoding.
--
-- Solo play reuses the existing "every player always has a party" shape
-- (ensurePartyId() in preview/index.html, real-venue-adventure/index.ts's
-- ensureParty action) rather than inventing a no-party mode — a solo round
-- is simply a round whose party currently has one member, same party_id/
-- adventure_id scoping coin_flip_challenges already uses.
--
-- Buzzer fairness: a round's live state (who currently has the exclusive
-- answer window, who's already been tried and failed/timed out) lives on
-- trivia_rounds itself and is only ever mutated inside plpgsql functions
-- below, each of which opens with `select ... for update` on the round
-- row. That row lock is the single choke point every state transition
-- (buzz claiming the floor, an answer landing, a timeout forcing the next
-- buzzer) serializes through, so two racing calls (e.g. a real answer
-- submission landing at the same instant as a client's timeout-driven
-- advance call) can never both mutate the round — whichever transaction's
-- lock is granted first completes its transition and commits; the second
-- re-reads post-commit state and safely no-ops. trivia_buzzes.buzz_seq
-- (bigserial, not a timestamp) is the tie-break authority for "who tapped
-- first" — Postgres assigns it atomically per insert, so it's immune to
-- same-millisecond clock ties two concurrent taps can otherwise produce.
--
-- The correct answer never touches a client-selectable column pre-reveal:
-- it lives only in trivia_round_secrets, which has NO select policy for
-- `authenticated` at all (only security definer functions, which run as
-- the function owner and bypass RLS, can read it — same trust boundary as
-- is_party_member()). At resolution, the adjudication function copies the
-- answer into trivia_rounds.correct_choice_key in the SAME locked
-- transaction that flips status, mirroring coin_flip_challenges.result's
-- "null until resolved" pattern exactly.

-- ---------------------------------------------------------------
-- trivia_rounds — one row per question shown to a party (or solo player)
-- ---------------------------------------------------------------

create table if not exists trivia_rounds (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references parties(id) on delete cascade,
  adventure_id uuid not null references adventures(id) on delete cascade,
  mode text not null check (mode in ('solo', 'group')),
  initiator_profile_id uuid not null references profiles(id) on delete cascade,
  round_number int not null,
  question_type text not null,
  question_text text not null,
  choices jsonb not null,                 -- [{ "key": "A", "text": "..." }, ...]
  source text not null default 'template' check (source in ('template', 'fallback', 'llm')),
  status text not null default 'buzzing' check (status in ('buzzing', 'answering', 'resolved', 'expired')),
  active_turn_profile_id uuid references profiles(id) on delete set null,
  tried_profile_ids uuid[] not null default '{}',
  correct_choice_key text,                -- null until resolved/expired (see header comment)
  explanation text,                       -- null until resolved/expired
  winner_profile_id uuid references profiles(id) on delete set null,
  xp_awarded int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

-- Solo mode starts a round directly in 'answering' with active_turn_
-- profile_id already set to the initiator — there's no one else to race,
-- so the buzzing phase is skipped entirely (see trivia edge function's
-- startRound action). The invariant this constraint actually enforces is
-- narrower than "solo always has an active turn": it only rules out a solo
-- round ever sitting in 'buzzing' (the one status solo never uses). An
-- earlier version also required active_turn_profile_id IS NOT NULL
-- whenever status <> 'buzzing', which looked right for the starting state
-- but was wrong as a general CHECK — CHECK constraints are re-evaluated on
-- every UPDATE, not just INSERT, and a solo round's own resolve/expire
-- transition (trivia_submit_answer / trivia_force_advance) legitimately
-- nulls active_turn_profile_id at the same time it flips status to
-- 'resolved'/'expired', which that stricter version rejected outright —
-- caught by testing the local buzzer flow end to end, not by inspection.
alter table trivia_rounds
  add constraint trivia_rounds_solo_never_buzzing
  check (mode <> 'solo' or status <> 'buzzing');

create index if not exists idx_trivia_rounds_party_adventure
  on trivia_rounds(party_id, adventure_id, created_at desc);

-- At most one LIVE group round per party+adventure at a time — startRound
-- relies on this unique-violation to detect "a round's already in flight"
-- and hand back the existing round instead of creating a duplicate, same
-- defensive-uniqueness spirit as check_ins' unique(adventure_id,
-- route_stop_id).
create unique index if not exists idx_trivia_rounds_one_live_group
  on trivia_rounds(party_id, adventure_id)
  where status in ('buzzing', 'answering') and mode = 'group';

-- Solo rounds are scoped per-initiator too, so two different party members
-- can each be mid-solo-round independently without colliding.
create unique index if not exists idx_trivia_rounds_one_live_solo
  on trivia_rounds(party_id, adventure_id, initiator_profile_id)
  where status in ('buzzing', 'answering') and mode = 'solo';

alter table trivia_rounds enable row level security;

create policy "party members read trivia rounds" on trivia_rounds for select using (
  is_party_member(party_id)
);
-- No insert/update/delete policy — every write goes through the trivia
-- edge function's service-role client via the functions below.

-- ---------------------------------------------------------------
-- trivia_round_secrets — the answer key, NEVER selectable by clients
-- ---------------------------------------------------------------

create table if not exists trivia_round_secrets (
  round_id uuid primary key references trivia_rounds(id) on delete cascade,
  correct_choice_key text not null,
  explanation text
);

alter table trivia_round_secrets enable row level security;
-- Deliberately zero policies for `authenticated` — RLS default-denies
-- every row when enabled with no matching policy, so even a client that
-- guesses this table's name and issues `select * from trivia_round_
-- secrets` gets zero rows back, always, regardless of party membership.
-- Only security definer functions (trivia_submit_answer/trivia_force_
-- advance below) ever read this table, and they run as the function
-- owner, which bypasses RLS entirely — same trust boundary as
-- is_party_member()/credit_coins()/award_xp().

-- ---------------------------------------------------------------
-- trivia_buzzes — insert-only log of every tap, true server-arrival order
-- ---------------------------------------------------------------

create table if not exists trivia_buzzes (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references trivia_rounds(id) on delete cascade,
  party_id uuid not null references parties(id) on delete cascade,  -- denormalized so ensurePartyRealtime's realtime filter (party_id=eq.X) can target this table directly, no join needed
  profile_id uuid not null references profiles(id) on delete cascade,
  buzz_seq bigserial,      -- authoritative tap-order tie-break (see header comment)
  buzzed_at timestamptz not null default now(),
  unique (round_id, profile_id)   -- one buzz per player per round; a repeat tap is a no-op, not a queue-jump
);

create index if not exists idx_trivia_buzzes_round_seq on trivia_buzzes(round_id, buzz_seq asc);

alter table trivia_buzzes enable row level security;
create policy "party members read trivia buzzes" on trivia_buzzes for select using (
  is_party_member(party_id)
);
-- No insert policy — every buzz is written by trivia_buzz_in() below,
-- called from the trivia edge function's service-role client, never
-- directly from an authenticated client. This is what makes the server-
-- received order (not client-reported tap time) the source of truth.

-- ---------------------------------------------------------------
-- trivia_answers — insert-only log of every answer attempt (audit trail)
-- ---------------------------------------------------------------

create table if not exists trivia_answers (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references trivia_rounds(id) on delete cascade,
  profile_id uuid not null references profiles(id) on delete cascade,
  choice_key text not null,
  is_correct boolean not null,
  answered_at timestamptz not null default now(),
  unique (round_id, profile_id)   -- one answer attempt per player per round, mirrors trivia_buzzes
);

alter table trivia_answers enable row level security;
create policy "party members read trivia answers" on trivia_answers for select using (
  exists (select 1 from trivia_rounds r where r.id = trivia_answers.round_id and is_party_member(r.party_id))
);
-- No insert policy — written only by trivia_submit_answer() below. Not
-- added to the realtime publication: every fact a client needs from this
-- table (who's now answering, who's been tried, the final outcome) is
-- already surfaced via trivia_rounds' own status/active_turn_profile_id/
-- tried_profile_ids changes, so a second realtime stream here would be
-- redundant chatter, not new information.

-- ---------------------------------------------------------------
-- trivia_buzz_in(): claim/log a tap. See header comment for the race-
-- safety argument (whole-function row lock on the round).
-- ---------------------------------------------------------------

create or replace function trivia_buzz_in(p_round_id uuid, p_profile_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_round trivia_rounds%rowtype;
  v_my_seq bigint;
  v_claim_profile uuid;
begin
  select * into v_round from trivia_rounds where id = p_round_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'round_not_found');
  end if;
  if v_round.mode = 'solo' then
    return jsonb_build_object('ok', false, 'error', 'solo_round_has_no_buzzer');
  end if;
  if v_round.status not in ('buzzing', 'answering') then
    return jsonb_build_object('ok', false, 'error', 'round_closed');
  end if;
  if p_profile_id = any(v_round.tried_profile_ids) then
    return jsonb_build_object('ok', false, 'error', 'already_tried');
  end if;

  insert into trivia_buzzes (round_id, party_id, profile_id)
  values (p_round_id, v_round.party_id, p_profile_id)
  on conflict (round_id, profile_id) do nothing
  returning buzz_seq into v_my_seq;

  if v_my_seq is null then
    -- Repeat tap from the same player — return their original seq rather
    -- than erroring, so a double-tap on a slow connection is harmless.
    select buzz_seq into v_my_seq from trivia_buzzes where round_id = p_round_id and profile_id = p_profile_id;
  end if;

  -- Only claim the floor if nobody currently has it. Because this whole
  -- function holds the round row lock, any OTHER concurrent caller is
  -- still blocked at its own `for update` above and hasn't inserted its
  -- buzz yet, so this SELECT is always evaluated against a fully settled,
  -- non-racing snapshot of trivia_buzzes for this round.
  if v_round.status = 'buzzing' then
    select b.profile_id into v_claim_profile
    from trivia_buzzes b
    where b.round_id = p_round_id and not (b.profile_id = any(v_round.tried_profile_ids))
    order by b.buzz_seq asc
    limit 1;

    update trivia_rounds
    set status = 'answering', active_turn_profile_id = v_claim_profile, updated_at = now()
    where id = p_round_id;
  end if;

  return jsonb_build_object('ok', true, 'myBuzzSeq', v_my_seq);
end;
$func$;

grant execute on function trivia_buzz_in(uuid, uuid) to service_role;

-- ---------------------------------------------------------------
-- trivia_submit_answer(): the active answerer submits a choice. Handles
-- both solo (always resolves immediately, right or wrong — no retries)
-- and group (wrong answer passes the floor to the next untried buzzer
-- from the SAME flurry; reopens the buzzer with no winner once the flurry
-- is exhausted so a late tap can still claim it).
-- ---------------------------------------------------------------

create or replace function trivia_submit_answer(p_round_id uuid, p_profile_id uuid, p_choice_key text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_round trivia_rounds%rowtype;
  v_secret trivia_round_secrets%rowtype;
  v_correct boolean;
  v_next_profile uuid;
begin
  select * into v_round from trivia_rounds where id = p_round_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'round_not_found');
  end if;
  if v_round.status <> 'answering' or v_round.active_turn_profile_id <> p_profile_id then
    return jsonb_build_object('ok', false, 'error', 'not_your_turn');
  end if;

  select * into v_secret from trivia_round_secrets where round_id = p_round_id;
  v_correct := (p_choice_key = v_secret.correct_choice_key);

  insert into trivia_answers (round_id, profile_id, choice_key, is_correct)
  values (p_round_id, p_profile_id, p_choice_key, v_correct)
  on conflict (round_id, profile_id) do nothing;

  if v_correct or v_round.mode = 'solo' then
    -- Correct (solo or group), OR a solo miss — either way this round is
    -- fully resolved, no retries. Reveal the answer atomically with the
    -- status flip.
    update trivia_rounds
    set status = 'resolved',
        winner_profile_id = case when v_correct then p_profile_id else null end,
        tried_profile_ids = array_append(tried_profile_ids, p_profile_id),
        correct_choice_key = v_secret.correct_choice_key,
        explanation = v_secret.explanation,
        active_turn_profile_id = null,
        resolved_at = now(), updated_at = now()
    where id = p_round_id;
    return jsonb_build_object('ok', true, 'correct', v_correct);
  end if;

  -- Group, wrong answer: pass the floor to the next untried buzz from the
  -- same flurry (buzzes recorded any time before resolution, not just a
  -- fixed initial window).
  update trivia_rounds set tried_profile_ids = array_append(tried_profile_ids, p_profile_id) where id = p_round_id;

  select b.profile_id into v_next_profile
  from trivia_buzzes b
  where b.round_id = p_round_id
    and b.profile_id <> all(array_append(v_round.tried_profile_ids, p_profile_id))
  order by b.buzz_seq asc
  limit 1;

  if v_next_profile is not null then
    update trivia_rounds
    set active_turn_profile_id = v_next_profile, status = 'answering', updated_at = now()
    where id = p_round_id;
    return jsonb_build_object('ok', true, 'correct', false, 'nextProfileId', v_next_profile);
  end if;

  -- Nobody else has buzzed (yet). Reopen to 'buzzing' rather than
  -- resolving outright — a late flurry tap can still come in and claim
  -- it. advanceTurn (timeout) is what eventually resolves a round that
  -- truly has no more takers (see trivia_force_advance below).
  update trivia_rounds
  set status = 'buzzing', active_turn_profile_id = null, updated_at = now()
  where id = p_round_id;
  return jsonb_build_object('ok', true, 'correct', false, 'nextProfileId', null);
end;
$func$;

grant execute on function trivia_submit_answer(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------
-- trivia_force_advance(): timeout path. Called by ANY party member's
-- client (not just the active answerer's — they may have backgrounded the
-- app) when a countdown runs out. Race-safe no-op if the round already
-- resolved by the time this call acquires the lock (e.g. an answer landed
-- a moment before the timeout fired) — this is exactly the "answer-
-- submission racing an admin timeout-advance" scenario the row lock is
-- designed to make safe.
-- ---------------------------------------------------------------

create or replace function trivia_force_advance(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $func$
declare
  v_round trivia_rounds%rowtype;
  v_secret trivia_round_secrets%rowtype;
  v_next_profile uuid;
  v_tried uuid[];
begin
  select * into v_round from trivia_rounds where id = p_round_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'round_not_found');
  end if;
  if v_round.status not in ('buzzing', 'answering') then
    -- Already resolved/expired by a different call that won the race —
    -- report success anyway, since the desired end state ("this round is
    -- no longer live") already holds.
    return jsonb_build_object('ok', true, 'noop', true, 'status', v_round.status);
  end if;

  v_tried := v_round.tried_profile_ids;
  if v_round.active_turn_profile_id is not null then
    -- Timing out the current answerer counts as a forfeited attempt, same
    -- as a submitted wrong answer, so they don't get re-tried below.
    v_tried := array_append(v_tried, v_round.active_turn_profile_id);
  end if;

  if v_round.mode = 'solo' then
    select * into v_secret from trivia_round_secrets where round_id = p_round_id;
    update trivia_rounds
    set status = 'expired', active_turn_profile_id = null, tried_profile_ids = v_tried,
        correct_choice_key = v_secret.correct_choice_key, explanation = v_secret.explanation,
        resolved_at = now(), updated_at = now()
    where id = p_round_id;
    return jsonb_build_object('ok', true, 'expired', true);
  end if;

  select b.profile_id into v_next_profile
  from trivia_buzzes b
  where b.round_id = p_round_id and not (b.profile_id = any(v_tried))
  order by b.buzz_seq asc limit 1;

  if v_next_profile is not null then
    update trivia_rounds
    set active_turn_profile_id = v_next_profile, status = 'answering',
        tried_profile_ids = v_tried, updated_at = now()
    where id = p_round_id;
    return jsonb_build_object('ok', true, 'nextProfileId', v_next_profile);
  end if;

  select * into v_secret from trivia_round_secrets where round_id = p_round_id;
  update trivia_rounds
  set status = 'expired', active_turn_profile_id = null, tried_profile_ids = v_tried,
      correct_choice_key = v_secret.correct_choice_key, explanation = v_secret.explanation,
      resolved_at = now(), updated_at = now()
  where id = p_round_id;
  return jsonb_build_object('ok', true, 'expired', true);
end;
$func$;

grant execute on function trivia_force_advance(uuid) to service_role;

-- Idempotent, same pattern as 0032_coin_flip_challenges.sql /
-- 0035_social_party_invites.sql. trivia_round_secrets and trivia_answers
-- are deliberately NOT added — secrets must never fan out over realtime
-- (defeats the whole point of hiding them), and trivia_answers' facts are
-- already covered by trivia_rounds' own realtime changes (see that
-- table's comment above).
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trivia_rounds') then
    alter publication supabase_realtime add table trivia_rounds;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'trivia_buzzes') then
    alter publication supabase_realtime add table trivia_buzzes;
  end if;
end $$;
