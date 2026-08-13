// POST /minigames
// Body: { action: 'listUnlocks' }
//     | { action: 'unlock', minigameKey: 'photo_challenge' | 'scavenger_clue' }
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
    return jsonResponse({ error: "Your session has expired — sign in again." }, 401);
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

  return jsonResponse({ error: "action must be 'listUnlocks' or 'unlock'" }, 400);
});
