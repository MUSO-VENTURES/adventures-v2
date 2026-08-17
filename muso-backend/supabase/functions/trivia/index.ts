// POST /trivia
// Body: { action: 'startRound', partyId, adventureId?, mode: 'solo'|'group', category? }
//     | { action: 'getActiveRound', partyId, adventureId?, mode: 'solo'|'group' }
//     | { action: 'buzzIn', roundId }
//     | { action: 'submitAnswer', roundId, choiceKey }
//     | { action: 'advanceTurn', roundId }
//     | { action: 'listRounds', partyId, adventureId?, limit? }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Trivia Break — solo or "quick draw" group buzzer trivia, drawn from the
// curated category bank in ../_shared/triviaGenerator.ts. adventureId is
// optional: mid-adventure, category auto-resolves from the party's current
// route theme (routes.venue_theme -> resolveCategory) unless the player
// picks a different one via the category-picker override; with no active
// adventure at all ("freeplay" — see preview/index.html's Trivia Break
// entry point), the picker is the only source of a category, so it's
// required in that case. See 0047_trivia_freeplay.sql for the schema side
// of making adventure_id optional.
//
// Played in fixed 5-question games (QUESTIONS_PER_GAME), each entirely at
// one difficulty tier tracked in trivia_progress, scoped per (party,
// adventure, mode) so solo and group play level up independently. A party
// starts at 'easy'; a perfect 5/5 game advances their NEXT game a tier
// (nextDifficulty, capped at 'hard'); anything less leaves the tier
// unchanged — there's no demotion. See 0044_trivia_games_and_leveling.sql.
//
// v2 of this function: the original version generated questions live from
// route_stops/venues/venue_reviews ("which venue is at stop 3?"). That read
// as flat/logistics trivia rather than actually fun trivia, so it's been
// replaced entirely with the static bank — see triviaGenerator.ts's header
// for the full rationale and content provenance.
//
// This is a dedicated function rather than new actions on minigames/
// index.ts — that file frames itself as unlock-bookkeeping (see its own
// header), with heads_or_tails' small challenge/pickSide gameplay as a
// deliberate one-off exception. Trivia's gameplay is materially larger,
// and its *unlock* already happens entirely in checkin/index.ts on a
// player's first check-in — this function never touches unlock state.
//
// Buzzer fairness ("first tap wins the answer window; if wrong, the next-
// fastest tap from the same flurry gets it, and so on"): every tap is
// logged in true server-arrival order (trivia_buzzes.buzz_seq, a
// bigserial) rather than adjudicated as a single one-shot claim like
// heads_or_tails' pickSide — a buzzer round gets claimed, missed, and
// re-claimed repeatedly, so buzzIn/submitAnswer/advanceTurn all delegate
// to plpgsql functions (0040_trivia_break.sql) that take a row lock on the
// round for the whole transition, making concurrent calls serialize safely
// instead of racing. The correct answer never reaches a client-selectable
// column until the round resolves (trivia_round_secrets has no client
// select policy at all) — same "server is the only source of truth"
// posture pickSide uses for the coin result.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { nextDifficulty, pickQuestion, QUESTIONS_PER_GAME, resolveCategory, TRIVIA_CATEGORIES } from "../_shared/triviaGenerator.ts";
import type { TriviaCategory, TriviaDifficulty } from "../_shared/triviaGenerator.ts";

// Inlined from ../_shared/cors.ts and ../_shared/supabaseAdmin.ts — see
// minigames/index.ts's comment for why (the dashboard's single-file editor
// doesn't reliably bundle sibling _shared/*.ts files). triviaGenerator.ts
// itself stays Deno-import-free on purpose so it's usable outside an edge
// function context (e.g. a plain unit test).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
};

function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Below Flip's head-to-head win (20 XP, minigames/index.ts) for group, and
// lower still for solo — see the plan's rationale: winning the buzz race
// is already the gate to earning XP at all, and solo has no race/social
// stakes, so both stay well under check-in's 50 XP to keep trivia in the
// "quick, repeatable, no-coin-cost" tier.
const TRIVIA_XP = {
  GROUP_WIN: 25,
  SOLO_WIN: 15,
};

function serializeRound(row: Record<string, unknown>) {
  const roundNumber = row.round_number as number;
  return {
    id: row.id,
    partyId: row.party_id,
    adventureId: row.adventure_id,
    mode: row.mode,
    initiatorProfileId: row.initiator_profile_id,
    roundNumber,
    // Purely computed from roundNumber, not stored — 1-indexed position
    // within the current 5-question game, and which game number this is.
    questionInGame: ((roundNumber - 1) % QUESTIONS_PER_GAME) + 1,
    gameNumber: Math.ceil(roundNumber / QUESTIONS_PER_GAME),
    category: row.category,
    difficulty: row.difficulty,
    questionType: row.question_type,
    questionText: row.question_text,
    choices: row.choices,
    source: row.source,
    status: row.status,
    activeTurnProfileId: row.active_turn_profile_id ?? null,
    triedProfileIds: row.tried_profile_ids ?? [],
    // Deliberately present, not stripped: correct_choice_key/explanation
    // are only ever non-null once trivia_submit_answer/trivia_force_advance
    // have already resolved the round server-side (see 0040_trivia_break.sql)
    // — passing them through here is safe by construction, not by omission.
    correctChoiceKey: row.correct_choice_key ?? null,
    explanation: row.explanation ?? null,
    winnerProfileId: row.winner_profile_id ?? null,
    xpAwarded: row.xp_awarded ?? null,
    // Only set on the 5th round of a game, once it resolves/expires — see
    // maybeCompleteGame() below.
    gameCorrectCount: row.game_correct_count ?? null,
    gameLeveledUp: row.game_leveled_up ?? null,
    gameNewDifficulty: row.game_new_difficulty ?? null,
    gameSummary: row.game_summary ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

// Every trivia_rounds/trivia_progress query below is scoped by adventureId,
// which is now optional (null = freeplay, no active adventure — see
// 0047_trivia_freeplay.sql). Supabase's .eq() compiles to SQL `= NULL`,
// which never matches anything, so a null adventureId has to route through
// .is() instead — this one helper keeps every call site correct without
// repeating the null check everywhere.
// deno-lint-ignore no-explicit-any
function eqOrIsNull(query: any, col: string, value: string | null) {
  return value === null ? query.is(col, value) : query.eq(col, value);
}

// Scoped by mode (not just party+adventure) so solo and group play count
// their own independent round sequences — otherwise mixing solo and group
// play within one adventure would interleave round numbers and split
// "games" (and the difficulty tier tied to them) across both modes.
async function nextRoundNumber(
  // deno-lint-ignore no-explicit-any
  admin: any,
  partyId: string,
  adventureId: string | null,
  mode: string,
): Promise<number> {
  const { data } = await eqOrIsNull(
    admin.from("trivia_rounds").select("round_number").eq("party_id", partyId),
    "adventure_id",
    adventureId,
  )
    .eq("mode", mode)
    .order("round_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.round_number as number | undefined) ?? 0) + 1;
}

// Reads the party's current difficulty tier for this adventure+mode,
// creating the row (defaulting to 'easy') on first play — satisfies "the
// first game should never be too hard" for free, since every new party/
// adventure/mode combination starts here.
async function getOrCreateProgress(
  // deno-lint-ignore no-explicit-any
  admin: any,
  partyId: string,
  adventureId: string | null,
  mode: string,
): Promise<TriviaDifficulty> {
  const { data: existing } = await eqOrIsNull(
    admin.from("trivia_progress").select("difficulty").eq("party_id", partyId),
    "adventure_id",
    adventureId,
  )
    .eq("mode", mode)
    .maybeSingle();
  if (existing) return existing.difficulty as TriviaDifficulty;

  const { data: created, error } = await admin
    .from("trivia_progress")
    .insert({ party_id: partyId, adventure_id: adventureId, mode })
    .select("difficulty")
    .single();
  if (error) {
    // Lost a create race against a concurrent startRound call (e.g. two
    // teammates tapping Play within the same instant) — the other call's
    // insert already landed, so just read what it wrote.
    const { data: raced } = await eqOrIsNull(
      admin.from("trivia_progress").select("difficulty").eq("party_id", partyId),
      "adventure_id",
      adventureId,
    )
      .eq("mode", mode)
      .maybeSingle();
    return (raced?.difficulty as TriviaDifficulty) ?? "easy";
  }
  return created.difficulty as TriviaDifficulty;
}

export interface GameSummaryItem {
  questionText: string;
  correct: boolean;
  winnerProfileId: string | null;
}

// Called right after submitAnswer/advanceTurn resolves a round. If that
// round was the LAST question of its game (questionInGame ===
// QUESTIONS_PER_GAME), builds the full recap of all 5 questions asked
// (question text + right/wrong, for the end-of-game summary list), tallies
// how many were answered correctly (winner_profile_id set — true for both
// solo and group, since both only ever set it on a correct answer), levels
// the party's next game up a tier on a perfect score, and writes the whole
// outcome onto this round row so it fans out to every party member via the
// existing trivia_rounds realtime subscription, not just the answering
// player's own HTTP response.
async function maybeCompleteGame(
  // deno-lint-ignore no-explicit-any
  admin: any,
  partyId: string,
  adventureId: string | null,
  mode: string,
  roundId: string,
  roundNumber: number,
): Promise<
  { gameCorrectCount: number; gameLeveledUp: boolean; gameNewDifficulty: TriviaDifficulty; gameSummary: GameSummaryItem[] } | null
> {
  const questionInGame = ((roundNumber - 1) % QUESTIONS_PER_GAME) + 1;
  if (questionInGame !== QUESTIONS_PER_GAME) return null;

  const gameStart = roundNumber - QUESTIONS_PER_GAME + 1;
  const { data: gameRounds } = await eqOrIsNull(
    admin.from("trivia_rounds").select("round_number, question_text, winner_profile_id").eq("party_id", partyId),
    "adventure_id",
    adventureId,
  )
    .eq("mode", mode)
    .gte("round_number", gameStart)
    .lte("round_number", roundNumber)
    .order("round_number", { ascending: true });

  const rows = (gameRounds ?? []) as Array<{ round_number: number; question_text: string; winner_profile_id: string | null }>;
  const gameSummary: GameSummaryItem[] = rows.map((r) => ({
    questionText: r.question_text,
    correct: r.winner_profile_id != null,
    winnerProfileId: r.winner_profile_id,
  }));
  const gameCorrectCount = gameSummary.filter((s) => s.correct).length;
  const perfect = gameCorrectCount === QUESTIONS_PER_GAME;

  const currentDifficulty = await getOrCreateProgress(admin, partyId, adventureId, mode);
  const gameNewDifficulty = perfect ? nextDifficulty(currentDifficulty) : currentDifficulty;
  const gameLeveledUp = perfect && gameNewDifficulty !== currentDifficulty;

  if (gameLeveledUp) {
    await eqOrIsNull(
      admin.from("trivia_progress")
        .update({ difficulty: gameNewDifficulty, updated_at: new Date().toISOString() })
        .eq("party_id", partyId),
      "adventure_id",
      adventureId,
    ).eq("mode", mode);
  }

  await admin
    .from("trivia_rounds")
    .update({
      game_correct_count: gameCorrectCount,
      game_leveled_up: gameLeveledUp,
      game_new_difficulty: gameNewDifficulty,
      game_summary: gameSummary,
    })
    .eq("id", roundId);

  return { gameCorrectCount, gameLeveledUp, gameNewDifficulty, gameSummary };
}

async function fetchLiveRound(
  // deno-lint-ignore no-explicit-any
  admin: any,
  partyId: string,
  adventureId: string | null,
  mode: string,
  initiatorProfileId?: string,
) {
  let query = eqOrIsNull(
    admin.from("trivia_rounds").select("*").eq("party_id", partyId),
    "adventure_id",
    adventureId,
  )
    .eq("mode", mode)
    .in("status", ["buzzing", "answering"]);
  if (mode === "solo" && initiatorProfileId) {
    query = query.eq("initiator_profile_id", initiatorProfileId);
  }
  const { data } = await query.order("created_at", { ascending: false }).limit(1).maybeSingle();
  return data ?? null;
}

function friendlyRpcError(error: string | undefined): string {
  switch (error) {
    case "round_not_found":
      return "That trivia round doesn't exist anymore.";
    case "solo_round_has_no_buzzer":
      return "Solo trivia has no buzzer — just pick an answer.";
    case "round_closed":
      return "This round already moved on.";
    case "already_tried":
      return "You already had your shot at this one.";
    case "not_your_turn":
      return "It's not your turn to answer.";
    default:
      return "That didn't go through — try again.";
  }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) {
    return jsonResponse({ error: "Sign in to play Trivia Break." }, 401);
  }

  const admin = getSupabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const userId = userData?.user?.id;
  if (userErr || !userId) {
    return jsonResponse({ error: "Your session has expired, sign in again." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action;

  // Shared by buzzIn/submitAnswer/advanceTurn — confirms the round exists
  // and the caller is a member of the party it belongs to. Service-role
  // writes bypass RLS, so this check is the actual enforcement point, the
  // same trust boundary as minigames/index.ts's 'challenge' action.
  async function requireRoundMembership(roundId: string) {
    const { data: round, error } = await admin.from("trivia_rounds").select("*").eq("id", roundId).maybeSingle();
    if (error) return { round: null, response: jsonResponse({ error: error.message }, 400) };
    if (!round) return { round: null, response: jsonResponse({ error: "Round not found." }, 404) };
    const { data: membership } = await admin
      .from("party_members")
      .select("profile_id")
      .eq("party_id", round.party_id)
      .eq("profile_id", userId)
      .maybeSingle();
    if (!membership) return { round: null, response: jsonResponse({ error: "You're not in that party." }, 403) };
    return { round, response: null };
  }

  if (action === "startRound") {
    const partyId = typeof body.partyId === "string" ? body.partyId : null;
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    const mode = body.mode === "solo" ? "solo" : "group";
    const requestedCategory = typeof body.category === "string" ? body.category as TriviaCategory : null;
    if (requestedCategory && !TRIVIA_CATEGORIES.includes(requestedCategory)) {
      return jsonResponse({ error: "category must be one of: " + TRIVIA_CATEGORIES.join(", ") }, 400);
    }
    if (!partyId) {
      return jsonResponse({ error: "partyId is required." }, 400);
    }

    const { data: membership } = await admin
      .from("party_members")
      .select("profile_id")
      .eq("party_id", partyId)
      .eq("profile_id", userId)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "You're not in that party." }, 403);

    // Mid-adventure: category auto-resolves from the route's theme, unless
    // the player explicitly overrode it (the "Change Category" CTA).
    // Freeplay (no adventureId — no route to resolve a theme from at all):
    // the category picker is the only way to get one, so it's required.
    let category: TriviaCategory;
    if (adventureId) {
      const { data: adventure } = await admin
        .from("adventures")
        .select("id, route_id")
        .eq("id", adventureId)
        .eq("party_id", partyId)
        .maybeSingle();
      if (!adventure) return jsonResponse({ error: "Adventure not found for that party." }, 404);

      const { data: route } = await admin
        .from("routes")
        .select("venue_theme")
        .eq("id", adventure.route_id)
        .maybeSingle();
      category = requestedCategory ?? resolveCategory(route?.venue_theme as string | null | undefined);
    } else {
      if (!requestedCategory) {
        return jsonResponse({ error: "category is required to play trivia without an active adventure." }, 400);
      }
      category = requestedCategory;
    }

    const roundNumber = await nextRoundNumber(admin, partyId, adventureId, mode);
    const difficulty = await getOrCreateProgress(admin, partyId, adventureId, mode);

    // Avoid repeating a question already asked this party+adventure+mode+
    // category — scoped by category too now that it can vary within one
    // adventure_id/null "slot" (the change-category override, or freeplay
    // switching categories between games) — best effort, not a hard
    // guarantee (pickQuestion falls back to allowing a repeat once a
    // bucket's fully exhausted, see its own comment).
    const { data: priorRounds } = await eqOrIsNull(
      admin.from("trivia_rounds").select("question_text").eq("party_id", partyId),
      "adventure_id",
      adventureId,
    )
      .eq("mode", mode)
      .eq("category", category)
      .limit(100);
    const excludeQuestionTexts = (priorRounds ?? []).map((r: Record<string, unknown>) => r.question_text as string);

    const question = pickQuestion(category, difficulty, excludeQuestionTexts);

    const startingStatus = mode === "solo" ? "answering" : "buzzing";
    const startingActiveTurn = mode === "solo" ? userId : null;

    const { data: round, error: insertErr } = await admin
      .from("trivia_rounds")
      .insert({
        party_id: partyId,
        adventure_id: adventureId,
        mode,
        initiator_profile_id: userId,
        round_number: roundNumber,
        category,
        difficulty,
        question_type: category,
        question_text: question.questionText,
        choices: question.choices,
        source: "curated",
        status: startingStatus,
        active_turn_profile_id: startingActiveTurn,
      })
      .select()
      .single();

    if (insertErr) {
      // Unique-violation on idx_trivia_rounds_one_live_* means a round's
      // already in flight (double "Play" tap, or a teammate started one a
      // beat earlier) — hand back the existing live round instead of
      // erroring, so everyone converges on one shared question.
      if (insertErr.code === "23505") {
        const existing = await fetchLiveRound(admin, partyId, adventureId, mode, userId);
        if (existing) return jsonResponse({ round: serializeRound(existing), rejoined: true });
      }
      return jsonResponse({ error: insertErr.message }, 400);
    }

    await admin.from("trivia_round_secrets").insert({
      round_id: round.id,
      correct_choice_key: question.correctChoiceKey,
      explanation: question.explanation,
    });

    return jsonResponse({ round: serializeRound(round) });
  }

  if (action === "getActiveRound") {
    const partyId = typeof body.partyId === "string" ? body.partyId : null;
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    const mode = body.mode === "solo" ? "solo" : "group";
    if (!partyId) {
      return jsonResponse({ error: "partyId is required." }, 400);
    }
    const round = await fetchLiveRound(admin, partyId, adventureId, mode, mode === "solo" ? userId : undefined);
    if (!round) return jsonResponse({ round: null, buzzes: [] });

    const { data: buzzes } = await admin
      .from("trivia_buzzes")
      .select("profile_id, buzz_seq, buzzed_at")
      .eq("round_id", round.id)
      .order("buzz_seq", { ascending: true });

    return jsonResponse({
      round: serializeRound(round),
      buzzes: (buzzes ?? []).map((b: Record<string, unknown>) => ({
        profileId: b.profile_id,
        buzzSeq: b.buzz_seq,
        buzzedAt: b.buzzed_at,
      })),
    });
  }

  if (action === "buzzIn") {
    const roundId = typeof body.roundId === "string" ? body.roundId : null;
    if (!roundId) return jsonResponse({ error: "roundId is required." }, 400);
    const { response } = await requireRoundMembership(roundId);
    if (response) return response;

    const { data, error } = await admin.rpc("trivia_buzz_in", { p_round_id: roundId, p_profile_id: userId });
    if (error) return jsonResponse({ error: error.message }, 400);
    if (!data.ok) return jsonResponse({ error: friendlyRpcError(data.error) }, 409);
    return jsonResponse({ ok: true, myBuzzSeq: data.myBuzzSeq });
  }

  if (action === "submitAnswer") {
    const roundId = typeof body.roundId === "string" ? body.roundId : null;
    const choiceKey = typeof body.choiceKey === "string" ? body.choiceKey : null;
    if (!roundId || !choiceKey) return jsonResponse({ error: "roundId and choiceKey are required." }, 400);
    const { round, response } = await requireRoundMembership(roundId);
    if (response) return response;

    const { data, error } = await admin.rpc("trivia_submit_answer", {
      p_round_id: roundId,
      p_profile_id: userId,
      p_choice_key: choiceKey,
    });
    if (error) return jsonResponse({ error: error.message }, 400);
    if (!data.ok) return jsonResponse({ error: friendlyRpcError(data.error) }, 409);

    let xpResult = null;
    if (data.correct) {
      const xpAmount = round!.mode === "solo" ? TRIVIA_XP.SOLO_WIN : TRIVIA_XP.GROUP_WIN;
      const { data: xp } = await admin.rpc("award_xp", { p_profile_id: userId, p_amount: xpAmount });
      await admin.from("trivia_rounds").update({ xp_awarded: xpAmount }).eq("id", roundId);
      xpResult = xp;
    }

    // The round is only actually OVER (not just passed to the next
    // buzzer) when it's correct, or it's solo (solo never retries) — see
    // trivia_submit_answer's own branching in 0040_trivia_break.sql.
    let game = null;
    if (data.correct || round!.mode === "solo") {
      game = await maybeCompleteGame(
        admin,
        round!.party_id as string,
        round!.adventure_id as string | null,
        round!.mode as string,
        roundId,
        round!.round_number as number,
      );
    }

    return jsonResponse({ ok: true, correct: data.correct, nextProfileId: data.nextProfileId ?? null, xpResult, game });
  }

  if (action === "advanceTurn") {
    const roundId = typeof body.roundId === "string" ? body.roundId : null;
    if (!roundId) return jsonResponse({ error: "roundId is required." }, 400);
    const { round, response } = await requireRoundMembership(roundId); // any party member may call this, not just the active answerer
    if (response) return response;

    const { data, error } = await admin.rpc("trivia_force_advance", { p_round_id: roundId });
    if (error) return jsonResponse({ error: error.message }, 400);

    // Only run game-completion bookkeeping for the call that actually just
    // expired the round — a `noop: true` response means some other call
    // already resolved/expired it first (and already ran this).
    let game = null;
    if (data.expired) {
      game = await maybeCompleteGame(
        admin,
        round!.party_id as string,
        round!.adventure_id as string | null,
        round!.mode as string,
        roundId,
        round!.round_number as number,
      );
    }

    return jsonResponse({ ...data, game });
  }

  if (action === "listRounds") {
    const partyId = typeof body.partyId === "string" ? body.partyId : null;
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    if (!partyId) {
      return jsonResponse({ error: "partyId is required." }, 400);
    }
    const { data: membership } = await admin
      .from("party_members")
      .select("profile_id")
      .eq("party_id", partyId)
      .eq("profile_id", userId)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "You're not in that party." }, 403);

    const { data, error } = await eqOrIsNull(
      admin.from("trivia_rounds").select("*").eq("party_id", partyId),
      "adventure_id",
      adventureId,
    ).order("round_number", { ascending: false })
      .limit(typeof body.limit === "number" ? body.limit : 20);
    if (error) return jsonResponse({ error: error.message }, 400);

    return jsonResponse({ rounds: (data ?? []).map(serializeRound) });
  }

  return jsonResponse(
    { error: "action must be one of: startRound, getActiveRound, buzzIn, submitAnswer, advanceTurn, listRounds" },
    400,
  );
});
