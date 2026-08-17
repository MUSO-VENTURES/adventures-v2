// POST /trivia
// Body: { action: 'startRound', partyId, adventureId, mode: 'solo'|'group' }
//     | { action: 'getActiveRound', partyId, adventureId, mode: 'solo'|'group' }
//     | { action: 'buzzIn', roundId }
//     | { action: 'submitAnswer', roundId, choiceKey }
//     | { action: 'advanceTurn', roundId }
//     | { action: 'listRounds', partyId, adventureId, limit? }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Trivia Break — solo or "quick draw" group buzzer trivia, generated from
// whatever route the caller's party is currently playing (curated or
// real-venue) via the template generator in ../_shared/triviaGenerator.ts.
// No LLM call: questions are built purely from route_stops/venues/
// venue_reviews already in the schema, so any new adventure works the
// instant it exists, with zero code changes here.
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
import {
  templateGenerator,
  type RouteContent,
  type StopContent,
} from "../_shared/triviaGenerator.ts";

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

// How many random cross-route rows to pull as wrong-answer padding for
// thin routes (e.g. right after a player's very first check-in). Cheap,
// best-effort — not meant to be a uniform random sample of the whole
// content library, just enough variety that a 1-stop route can still
// produce a plausible multiple-choice question.
const DISTRACTOR_POOL_SIZE = 24;
const DISTRACTOR_TAKE = 12;

function shuffle<T>(arr: T[]): T[] {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function serializeRound(row: Record<string, unknown>) {
  return {
    id: row.id,
    partyId: row.party_id,
    adventureId: row.adventure_id,
    mode: row.mode,
    initiatorProfileId: row.initiator_profile_id,
    roundNumber: row.round_number,
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
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
}

async function loadRouteContent(
  // deno-lint-ignore no-explicit-any
  admin: any,
  routeId: string,
): Promise<RouteContent> {
  const { data: route } = await admin
    .from("routes")
    .select("id, title")
    .eq("id", routeId)
    .maybeSingle();

  const { data: stopRows } = await admin
    .from("route_stops")
    .select("id, stop_order, name, description, emoji, is_mystery, venue_id")
    .eq("route_id", routeId)
    .eq("is_mystery", false)
    .order("stop_order", { ascending: true });

  const venueIds = (stopRows ?? []).map((s: Record<string, unknown>) => s.venue_id).filter(Boolean) as string[];

  const [{ data: venueRows }, { data: reviewRows }] = await Promise.all([
    venueIds.length
      ? admin.from("venues").select("id, name, category, address, muso_rating, muso_rating_count").in("id", venueIds)
      : Promise.resolve({ data: [] }),
    venueIds.length
      ? admin.from("venue_reviews").select("venue_id, rating, review_text").in("venue_id", venueIds).limit(60)
      : Promise.resolve({ data: [] }),
  ]);

  const venueById = new Map((venueRows ?? []).map((v: Record<string, unknown>) => [v.id, v]));
  const reviewsByVenue = new Map<string, Array<{ rating: number; reviewText: string | null }>>();
  for (const r of reviewRows ?? []) {
    const list = reviewsByVenue.get(r.venue_id as string) ?? [];
    list.push({ rating: r.rating as number, reviewText: (r.review_text as string | null) ?? null });
    reviewsByVenue.set(r.venue_id as string, list);
  }

  const stops: StopContent[] = (stopRows ?? []).map((s: Record<string, unknown>) => {
    const venue = s.venue_id ? (venueById.get(s.venue_id as string) as Record<string, unknown> | undefined) : undefined;
    return {
      id: s.id as string,
      stopOrder: s.stop_order as number,
      name: s.name as string,
      description: (s.description as string | null) ?? null,
      emoji: (s.emoji as string | null) ?? null,
      isMystery: Boolean(s.is_mystery),
      venue: venue
        ? {
            name: venue.name as string,
            category: (venue.category as string | null) ?? null,
            address: (venue.address as string | null) ?? null,
            musoRating: (venue.muso_rating as number | null) ?? null,
            musoRatingCount: (venue.muso_rating_count as number | null) ?? 0,
          }
        : null,
      reviews: s.venue_id ? reviewsByVenue.get(s.venue_id as string) ?? [] : [],
    };
  });

  // Cross-route padding for thin routes — cheap, best-effort, no strict
  // randomness guarantee (Postgres row order without an ORDER BY isn't
  // random; shuffling client-side over a wider-than-needed slice is
  // simpler than an ORDER BY random() and good enough for distractor text).
  const [{ data: otherStopRows }, { data: otherRouteRows }] = await Promise.all([
    admin.from("route_stops").select("name, emoji").neq("route_id", routeId).eq("is_mystery", false).limit(DISTRACTOR_POOL_SIZE),
    admin.from("routes").select("title").neq("id", routeId).limit(DISTRACTOR_POOL_SIZE),
  ]);

  const distractorStopNames = shuffle((otherStopRows ?? []).map((s: Record<string, unknown>) => s.name as string)).slice(0, DISTRACTOR_TAKE);
  const distractorEmojis = shuffle(
    (otherStopRows ?? []).map((s: Record<string, unknown>) => s.emoji as string | null).filter((e: string | null): e is string => Boolean(e)),
  ).slice(0, DISTRACTOR_TAKE);
  const distractorRouteTitles = shuffle((otherRouteRows ?? []).map((r: Record<string, unknown>) => r.title as string)).slice(0, DISTRACTOR_TAKE);

  return {
    routeId,
    routeTitle: (route?.title as string) ?? "This Adventure",
    stops,
    distractorStopNames,
    distractorRouteTitles,
    distractorEmojis,
  };
}

async function nextRoundNumber(
  // deno-lint-ignore no-explicit-any
  admin: any,
  partyId: string,
  adventureId: string,
): Promise<number> {
  const { data } = await admin
    .from("trivia_rounds")
    .select("round_number")
    .eq("party_id", partyId)
    .eq("adventure_id", adventureId)
    .order("round_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  return ((data?.round_number as number | undefined) ?? 0) + 1;
}

async function fetchLiveRound(
  // deno-lint-ignore no-explicit-any
  admin: any,
  partyId: string,
  adventureId: string,
  mode: string,
  initiatorProfileId?: string,
) {
  let query = admin
    .from("trivia_rounds")
    .select("*")
    .eq("party_id", partyId)
    .eq("adventure_id", adventureId)
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
    if (!partyId || !adventureId) {
      return jsonResponse({ error: "partyId and adventureId are required." }, 400);
    }

    const { data: membership } = await admin
      .from("party_members")
      .select("profile_id")
      .eq("party_id", partyId)
      .eq("profile_id", userId)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "You're not in that party." }, 403);

    const { data: adventure } = await admin
      .from("adventures")
      .select("id, route_id")
      .eq("id", adventureId)
      .eq("party_id", partyId)
      .maybeSingle();
    if (!adventure) return jsonResponse({ error: "Adventure not found for that party." }, 404);

    const routeContent = await loadRouteContent(admin, adventure.route_id as string);
    const roundNumber = await nextRoundNumber(admin, partyId, adventureId);
    const [question] = templateGenerator.generate(routeContent, 1);
    if (!question) {
      return jsonResponse({ error: "Couldn't put together a trivia question right now — try again in a bit." }, 500);
    }

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
        question_type: question.questionType,
        question_text: question.questionText,
        choices: question.choices,
        source: question.source ?? "template",
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
    if (!partyId || !adventureId) {
      return jsonResponse({ error: "partyId and adventureId are required." }, 400);
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
    return jsonResponse({ ok: true, correct: data.correct, nextProfileId: data.nextProfileId ?? null, xpResult });
  }

  if (action === "advanceTurn") {
    const roundId = typeof body.roundId === "string" ? body.roundId : null;
    if (!roundId) return jsonResponse({ error: "roundId is required." }, 400);
    const { response } = await requireRoundMembership(roundId); // any party member may call this, not just the active answerer
    if (response) return response;

    const { data, error } = await admin.rpc("trivia_force_advance", { p_round_id: roundId });
    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse(data);
  }

  if (action === "listRounds") {
    const partyId = typeof body.partyId === "string" ? body.partyId : null;
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    if (!partyId || !adventureId) {
      return jsonResponse({ error: "partyId and adventureId are required." }, 400);
    }
    const { data: membership } = await admin
      .from("party_members")
      .select("profile_id")
      .eq("party_id", partyId)
      .eq("profile_id", userId)
      .maybeSingle();
    if (!membership) return jsonResponse({ error: "You're not in that party." }, 403);

    const { data, error } = await admin
      .from("trivia_rounds")
      .select("*")
      .eq("party_id", partyId)
      .eq("adventure_id", adventureId)
      .order("round_number", { ascending: false })
      .limit(typeof body.limit === "number" ? body.limit : 20);
    if (error) return jsonResponse({ error: error.message }, 400);

    return jsonResponse({ rounds: (data ?? []).map(serializeRound) });
  }

  return jsonResponse(
    { error: "action must be one of: startRound, getActiveRound, buzzIn, submitAnswer, advanceTurn, listRounds" },
    400,
  );
});
