// POST /minigames
// Body: { action: 'listUnlocks' }
//     | { action: 'unlock', minigameKey: 'photo_challenge' | 'scavenger_clue' }
//     | { action: 'challenge', partyId, adventureId, opponentId, prompt?: string }
//     | { action: 'pickSide', challengeId, call: 'heads' | 'tails' }
//     | { action: 'respondToChallenge', challengeId, response: 'decline' }
//     | { action: 'cancelChallenge', challengeId }
//     | { action: 'listChallenges', partyId, adventureId }
//     | { action: 'flipStatus', adventureId }
//     | { action: 'useFlip', adventureId }
//     | { action: 'buyFlips', adventureId }
//     | { action: 'nameCustomFlip', prompt, adventureId? }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Mini games are quick, optional play elements droppable into any
// adventure. 'trivia' is the starter game — it unlocks automatically the
// moment a player's first check-in lands (see checkin/index.ts), no coins
// or level needed, so there's always something to play right away. Every
// other mini game stays locked until either (a) the player's level clears
// its free-unlock threshold, or (b) they buy it outright with Adventure
// Coins — same "free at a level, or pay to skip the wait" dual path as
// unlock-feature/index.ts's venue_search/extra_stops unlocks, and same
// coin-spend machinery (debit_coins).
//
// Actual gameplay/content for each mini game ships separately from this
// function — this only tracks and gates *unlock state*, so the picker can
// show Play vs Locked and the purchase button, regardless of what each
// game turns out to look like once it's wired in.
//
// heads_or_tails is the one exception with real gameplay living here: the
// challenge/pickSide/respondToChallenge/cancelChallenge/listChallenges
// actions back a head-to-head coin flip between two members of the same
// party, backed by coin_flip_challenges (0032_coin_flip_challenges.sql,
// 0037_flip_race_pick.sql). Sending a challenge doesn't lock in a side —
// both players see an open "pick heads or tails" race, and pickSide claims
// whichever side reaches the server first via an atomic conditional
// update (challenger_call IS NULL), so two near-simultaneous picks can
// never collide. The flip result is decided immediately, server-side, the
// instant a pick lands — never left to either client — because two
// different devices need to land on the exact same outcome, and only a
// single trusted source can pick it fairly. Winner XP goes through
// award_xp, the same RPC checkin/index.ts uses for check-in XP.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined from ../_shared/cors.ts and ../_shared/supabaseAdmin.ts — see
// unlock-feature/index.ts's comment for why (the dashboard's single-file
// editor doesn't reliably bundle sibling _shared/*.ts files).

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

// Purchasable/level-gated mini games only — 'trivia' isn't listed here on
// purpose, it never goes through this function's unlock action (it's
// granted directly by checkin/index.ts on a player's first check-in).
const MINIGAME_REGISTRY: Record<string, { label: string; freeAtLevel: number; cost: number }> = {
  photo_challenge: { label: "Photo Challenge", freeAtLevel: 4, cost: 150 },
  scavenger_clue: { label: "Scavenger Hunt", freeAtLevel: 7, cost: 250 },
};

// Below check-in's 50 XP on purpose — this is a quick, repeatable, no-
// coin-cost side game, not a route milestone.
const COIN_FLIP_CHALLENGE_XP = 20;

// Solo-flip budget (0034_flip_budget.sql / consume_flip()) — 5 free flips
// per adventure, +1 automatic per check-in on that adventure, then buyable
// in packs. Only the solo flip is metered; head-to-head challenges above
// stay unlimited (see the migration's own comment for why).
const FREE_FLIPS_BASE = 5;
const FLIP_PACK_SIZE = 5;
const FLIP_PACK_COST = 50;

// Naming your own solo flip (0036_custom_flip_prompt_coins.sql) — a flat
// fee charged once at naming time, independent of the flip budget above
// entirely. The 6 built-in presets stay free and only ever consume the
// normal budget; this is purely the cost of typing something custom.
const CUSTOM_PROMPT_COST = 10;

function otherCall(call: "heads" | "tails"): "heads" | "tails" {
  return call === "heads" ? "tails" : "heads";
}

// Best-effort PG-13 gate on player-typed challenge prompts ("Who gets a
// back rub?" is fine, cruelty/violence/explicit content isn't). This is
// the real enforcement point — any client-side check is UX only, since a
// client can always be bypassed. Not a substitute for a real moderation
// pipeline (no wordlist is airtight), but prompts here are short single-
// sentence questions shown to a whole party, so a blocklist covers the
// realistic abuse cases without false-positiving on ordinary phrasing.
// No age-verification exists anywhere in this app, so there is no NC-17
// tier — everything typed here has to clear the PG-13 bar or it's rejected
// outright.
const BLOCKED_PROMPT_TERMS = [
  // violence / cruelty / self-harm
  "kill", "murder", "suicide", "self.?harm", "cut yourself", "torture",
  "beat (up|you|him|her|them)", "stab", "shoot", "abuse", "hurt yourself",
  // sexual/explicit
  "sex", "porn", "nude", "naked", "blowjob", "handjob", "orgasm", "fuck",
  "rape", "molest",
  // hate speech / slurs (representative, not exhaustive)
  "nigger", "faggot", "retard(ed)?", "spic", "chink", "kike",
];
const BLOCKED_PROMPT_RE = new RegExp("\\b(" + BLOCKED_PROMPT_TERMS.join("|") + ")\\b", "i");

function promptRejectionReason(prompt: string): string | null {
  if (prompt.length > 200) return "Keep the prompt under 200 characters.";
  if (BLOCKED_PROMPT_RE.test(prompt)) {
    return "That prompt isn't allowed. Keep it PG-13: no cruelty, violence, or explicit content.";
  }
  return null;
}

function serializeChallenge(row: Record<string, unknown>) {
  const challengerCall = (row.challenger_call ?? null) as "heads" | "tails" | null;
  return {
    id: row.id,
    partyId: row.party_id,
    adventureId: row.adventure_id,
    challengerId: row.challenger_id,
    opponentId: row.opponent_id,
    // Despite the column name, this is "whichever side got locked in
    // first," not necessarily the challenger's own pick — see
    // firstPickerId, and 0037_flip_race_pick.sql's header comment.
    challengerCall,
    opponentCall: challengerCall ? otherCall(challengerCall) : null,
    firstPickerId: row.first_picker_id ?? null,
    prompt: row.prompt ?? null,
    status: row.status,
    result: row.result ?? null,
    winnerId: row.winner_id ?? null,
    xpAwarded: row.xp_awarded ?? null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at ?? null,
  };
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
    return jsonResponse({ error: "Sign in to play mini games." }, 401);
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

  if (action === "listUnlocks") {
    const { data, error } = await admin
      .from("profile_minigames")
      .select("minigame_key, unlocked_via, unlocked_at")
      .eq("profile_id", userId);
    if (error) return jsonResponse({ error: error.message }, 400);
    return jsonResponse({ unlocks: data ?? [] });
  }

  if (action === "unlock") {
    const minigameKey = typeof body.minigameKey === "string" ? body.minigameKey : null;
    const config = minigameKey ? MINIGAME_REGISTRY[minigameKey] : null;
    if (!minigameKey || !config) {
      return jsonResponse(
        { error: "minigameKey must be one of: " + Object.keys(MINIGAME_REGISTRY).join(", ") },
        400,
      );
    }

    const { data: existing } = await admin
      .from("profile_minigames")
      .select("minigame_key")
      .eq("profile_id", userId)
      .eq("minigame_key", minigameKey)
      .maybeSingle();
    if (existing) {
      return jsonResponse({ ok: true, alreadyUnlocked: true, minigameKey });
    }

    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("level, adventure_coins")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr || !profile) {
      return jsonResponse({ error: "Couldn't load your profile." }, 400);
    }

    if ((profile.level ?? 1) >= config.freeAtLevel) {
      const { error: insertErr } = await admin
        .from("profile_minigames")
        .insert({ profile_id: userId, minigame_key: minigameKey, unlocked_via: "level" });
      if (insertErr) return jsonResponse({ error: insertErr.message }, 400);
      return jsonResponse({ ok: true, unlocked: true, minigameKey, method: "level" });
    }

    const { data: success, error: debitErr } = await admin.rpc("debit_coins", {
      p_profile_id: userId,
      p_amount: config.cost,
      p_reason: "unlock_minigame",
    });
    if (debitErr) return jsonResponse({ error: debitErr.message }, 400);
    if (!success) {
      return jsonResponse(
        {
          error: `Not enough Adventure Coins. Need ${config.cost}, you have ${profile.adventure_coins}. Reach Level ${config.freeAtLevel} to unlock ${config.label} for free instead.`,
        },
        402,
      );
    }

    const { error: insertErr } = await admin
      .from("profile_minigames")
      .insert({ profile_id: userId, minigame_key: minigameKey, unlocked_via: "purchase" });
    if (insertErr) return jsonResponse({ error: insertErr.message }, 400);

    return jsonResponse({ ok: true, unlocked: true, minigameKey, method: "coins", spent: config.cost });
  }

  if (action === "challenge") {
    const partyId = typeof body.partyId === "string" ? body.partyId : null;
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    const opponentId = typeof body.opponentId === "string" ? body.opponentId : null;
    const promptRaw = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const prompt = promptRaw.length ? promptRaw : null;

    if (!partyId || !adventureId || !opponentId) {
      return jsonResponse(
        { error: "partyId, adventureId, and opponentId are all required." },
        400,
      );
    }
    if (opponentId === userId) {
      return jsonResponse({ error: "You can't challenge yourself." }, 400);
    }
    if (prompt) {
      const rejection = promptRejectionReason(prompt);
      if (rejection) return jsonResponse({ error: rejection }, 400);
    }

    // Service-role writes bypass RLS, so party membership has to be
    // checked here explicitly — both players must currently be in the
    // party being challenged in, same trust boundary is_party_member()
    // enforces for reads.
    const { data: members, error: membersErr } = await admin
      .from("party_members")
      .select("profile_id")
      .eq("party_id", partyId)
      .in("profile_id", [userId, opponentId]);
    if (membersErr) return jsonResponse({ error: membersErr.message }, 400);
    const memberIds = new Set((members ?? []).map((m) => m.profile_id));
    if (!memberIds.has(userId)) {
      return jsonResponse({ error: "You're not in that party." }, 403);
    }
    if (!memberIds.has(opponentId)) {
      return jsonResponse({ error: "That player isn't in your party." }, 403);
    }

    const { data: inserted, error: insertErr } = await admin
      .from("coin_flip_challenges")
      .insert({
        party_id: partyId,
        adventure_id: adventureId,
        challenger_id: userId,
        opponent_id: opponentId,
        prompt,
      })
      .select()
      .single();
    if (insertErr) return jsonResponse({ error: insertErr.message }, 400);

    return jsonResponse({ challenge: serializeChallenge(inserted) });
  }

  if (action === "pickSide") {
    const challengeId = typeof body.challengeId === "string" ? body.challengeId : null;
    const call = body.call === "heads" || body.call === "tails" ? body.call : null;
    if (!challengeId || !call) {
      return jsonResponse({ error: "challengeId and call ('heads' | 'tails') are required." }, 400);
    }

    const { data: challenge, error: fetchErr } = await admin
      .from("coin_flip_challenges")
      .select("*")
      .eq("id", challengeId)
      .maybeSingle();
    if (fetchErr) return jsonResponse({ error: fetchErr.message }, 400);
    if (!challenge) return jsonResponse({ error: "Challenge not found." }, 404);
    if (challenge.challenger_id !== userId && challenge.opponent_id !== userId) {
      return jsonResponse({ error: "You're not part of this challenge." }, 403);
    }
    if (challenge.status !== "pending") {
      return jsonResponse({ error: "This challenge isn't open anymore." }, 409);
    }

    // Race lock: only the pick that reaches this WHERE clause first
    // actually updates a row. Postgres locks and serializes concurrent
    // UPDATEs against the same row, so a near-simultaneous second pick
    // always re-evaluates the WHERE clause after the first has committed,
    // finds challenger_call no longer null, and matches zero rows —
    // there's no way for both picks to land.
    const { data: claimed, error: claimErr } = await admin
      .from("coin_flip_challenges")
      .update({ challenger_call: call, first_picker_id: userId })
      .eq("id", challengeId)
      .eq("status", "pending")
      .is("challenger_call", null)
      .select()
      .maybeSingle();
    if (claimErr) return jsonResponse({ error: claimErr.message }, 400);
    if (!claimed) {
      return jsonResponse({ error: "Too slow, the other player already called it." }, 409);
    }

    // Claiming the pick resolves the flip immediately, server-side — the
    // instant one side is known the other is forced, so there's no reason
    // to wait on a separate accept step. This is the single source of
    // truth both players' clients animate toward, so there's no way for
    // two devices to disagree on the outcome.
    const randBuf = new Uint32Array(1);
    crypto.getRandomValues(randBuf);
    const result: "heads" | "tails" = randBuf[0] / 4294967296 < 0.5 ? "heads" : "tails";
    const otherPlayerId = userId === claimed.challenger_id ? claimed.opponent_id : claimed.challenger_id;
    const winnerId = result === call ? userId : otherPlayerId;

    const { data: updated, error: updateErr } = await admin
      .from("coin_flip_challenges")
      .update({
        status: "resolved",
        result,
        winner_id: winnerId,
        xp_awarded: COIN_FLIP_CHALLENGE_XP,
        resolved_at: new Date().toISOString(),
      })
      .eq("id", challengeId)
      .select()
      .single();
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);

    const { data: xpData } = await admin.rpc("award_xp", {
      p_profile_id: winnerId,
      p_amount: COIN_FLIP_CHALLENGE_XP,
    });
    const xpResult = (xpData ?? {}) as { oldLevel?: number; newLevel?: number; leveledUp?: boolean };

    return jsonResponse({ challenge: serializeChallenge(updated), xpResult });
  }

  if (action === "respondToChallenge") {
    const challengeId = typeof body.challengeId === "string" ? body.challengeId : null;
    const response = body.response === "decline" ? body.response : null;
    if (!challengeId || !response) {
      return jsonResponse({ error: "challengeId and response ('decline') are required." }, 400);
    }

    const { data: challenge, error: fetchErr } = await admin
      .from("coin_flip_challenges")
      .select("opponent_id, status")
      .eq("id", challengeId)
      .maybeSingle();
    if (fetchErr) return jsonResponse({ error: fetchErr.message }, 400);
    if (!challenge) return jsonResponse({ error: "Challenge not found." }, 404);
    if (challenge.opponent_id !== userId) {
      return jsonResponse({ error: "Only the challenged player can respond to this." }, 403);
    }
    if (challenge.status !== "pending") {
      return jsonResponse({ error: "This challenge isn't pending anymore." }, 409);
    }

    const { data: updated, error: updateErr } = await admin
      .from("coin_flip_challenges")
      .update({ status: "declined", resolved_at: new Date().toISOString() })
      .eq("id", challengeId)
      .select()
      .single();
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);
    return jsonResponse({ challenge: serializeChallenge(updated) });
  }

  if (action === "cancelChallenge") {
    const challengeId = typeof body.challengeId === "string" ? body.challengeId : null;
    if (!challengeId) return jsonResponse({ error: "challengeId is required." }, 400);

    const { data: challenge, error: fetchErr } = await admin
      .from("coin_flip_challenges")
      .select("challenger_id, status")
      .eq("id", challengeId)
      .maybeSingle();
    if (fetchErr) return jsonResponse({ error: fetchErr.message }, 400);
    if (!challenge) return jsonResponse({ error: "Challenge not found." }, 404);
    if (challenge.challenger_id !== userId) {
      return jsonResponse({ error: "Only the challenger can cancel this." }, 403);
    }
    if (challenge.status !== "pending") {
      return jsonResponse({ error: "This challenge isn't pending anymore." }, 409);
    }

    const { data: updated, error: updateErr } = await admin
      .from("coin_flip_challenges")
      .update({ status: "cancelled", resolved_at: new Date().toISOString() })
      .eq("id", challengeId)
      .select()
      .single();
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);
    return jsonResponse({ challenge: serializeChallenge(updated) });
  }

  if (action === "listChallenges") {
    const partyId = typeof body.partyId === "string" ? body.partyId : null;
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    if (!partyId || !adventureId) {
      return jsonResponse({ error: "partyId and adventureId are required." }, 400);
    }

    const { data, error } = await admin
      .from("coin_flip_challenges")
      .select("*")
      .eq("party_id", partyId)
      .eq("adventure_id", adventureId)
      .or(`challenger_id.eq.${userId},opponent_id.eq.${userId}`)
      .order("created_at", { ascending: false })
      .limit(20);
    if (error) return jsonResponse({ error: error.message }, 400);

    return jsonResponse({ challenges: (data ?? []).map(serializeChallenge) });
  }

  if (action === "flipStatus") {
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    if (!adventureId) return jsonResponse({ error: "adventureId is required." }, 400);

    const { count: checkinCount, error: checkinErr } = await admin
      .from("check_ins")
      .select("id", { count: "exact", head: true })
      .eq("checked_in_by", userId)
      .eq("adventure_id", adventureId);
    if (checkinErr) return jsonResponse({ error: checkinErr.message }, 400);

    const { data: usage, error: usageErr } = await admin
      .from("minigame_flip_usage")
      .select("flips_used, bonus_flips_purchased")
      .eq("profile_id", userId)
      .eq("adventure_id", adventureId)
      .maybeSingle();
    if (usageErr) return jsonResponse({ error: usageErr.message }, 400);

    const used = usage?.flips_used ?? 0;
    const bonus = usage?.bonus_flips_purchased ?? 0;
    const allowance = FREE_FLIPS_BASE + (checkinCount ?? 0) + bonus;
    const remaining = Math.max(0, allowance - used);

    return jsonResponse({ remaining, allowance, used, checkinCount: checkinCount ?? 0, bonusPurchased: bonus });
  }

  // Spends one flip from the caller's budget for this adventure — call
  // this right before letting a solo flip animate, not after. consume_flip
  // (0034_flip_budget.sql) does the same allowance math as flipStatus above
  // but atomically, under a row lock, so two flips fired back-to-back can't
  // both slip through on the last flip in the budget.
  if (action === "useFlip") {
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    if (!adventureId) return jsonResponse({ error: "adventureId is required." }, 400);

    const { data, error } = await admin.rpc("consume_flip", {
      p_profile_id: userId,
      p_adventure_id: adventureId,
    });
    if (error) return jsonResponse({ error: error.message }, 400);

    const result = data as { ok: boolean; remaining: number; allowance: number; used: number };
    if (!result.ok) {
      return jsonResponse(
        { error: "Out of free flips for this adventure.", remaining: 0, allowance: result.allowance },
        402,
      );
    }
    return jsonResponse({ ok: true, remaining: result.remaining, allowance: result.allowance, used: result.used });
  }

  if (action === "buyFlips") {
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    if (!adventureId) return jsonResponse({ error: "adventureId is required." }, 400);

    const { data: success, error: debitErr } = await admin.rpc("debit_coins", {
      p_profile_id: userId,
      p_amount: FLIP_PACK_COST,
      p_reason: "buy_flips",
      p_adventure_id: adventureId,
    });
    if (debitErr) return jsonResponse({ error: debitErr.message }, 400);
    if (!success) {
      return jsonResponse({ error: `Not enough Adventure Coins. Need ${FLIP_PACK_COST}.` }, 402);
    }

    const { error: bonusErr } = await admin.rpc("add_bonus_flips", {
      p_profile_id: userId,
      p_adventure_id: adventureId,
      p_amount: FLIP_PACK_SIZE,
    });
    if (bonusErr) return jsonResponse({ error: bonusErr.message }, 400);

    return jsonResponse({ ok: true, added: FLIP_PACK_SIZE, spent: FLIP_PACK_COST });
  }

  // Charges the flat naming fee for the solo Flip's "name your own" picker
  // option (preview/index.html) — completely separate from the flip
  // budget above, so it's chargeable even outside an active adventure
  // (adventureId is only passed through for transaction attribution when
  // one happens to be active). Reuses the same PG-13 wordlist the
  // head-to-head challenge prompt already goes through.
  if (action === "nameCustomFlip") {
    const promptRaw = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    if (!promptRaw) return jsonResponse({ error: "Type something to name your flip." }, 400);
    const rejection = promptRejectionReason(promptRaw);
    if (rejection) return jsonResponse({ error: rejection }, 400);

    const { data: success, error: debitErr } = await admin.rpc("debit_coins", {
      p_profile_id: userId,
      p_amount: CUSTOM_PROMPT_COST,
      p_reason: "custom_flip_prompt",
      p_adventure_id: adventureId,
    });
    if (debitErr) return jsonResponse({ error: debitErr.message }, 400);
    if (!success) {
      return jsonResponse({ error: `Not enough Adventure Coins. Need ${CUSTOM_PROMPT_COST}.` }, 402);
    }

    return jsonResponse({ ok: true, prompt: promptRaw, spent: CUSTOM_PROMPT_COST });
  }

  return jsonResponse(
    {
      error:
        "action must be one of: listUnlocks, unlock, challenge, respondToChallenge, cancelChallenge, " +
        "listChallenges, flipStatus, useFlip, buyFlips, nameCustomFlip",
    },
    400,
  );
});
