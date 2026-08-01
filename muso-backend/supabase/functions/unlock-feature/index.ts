// POST /unlock-feature
// Body: { feature: 'venue_search' | 'radius' | 'extra_stops' }
//     | { feature: 'theme', themeId: string, action?: 'unlock' | 'activate' }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// 'venue_search' — unlocks real results from venues-search. Free once the
// caller's profile reaches Level 5 (xp >= 400); otherwise costs
// VENUE_SEARCH_COST Adventure Coins. Permanent once unlocked.
//
// 'radius' — raises the caller's unlocked_radius_miles from the free 30mi
// default up to RADIUS_UNLOCK_MILES (50mi). Coins-only, no level path.
// Permanent once unlocked (re-running it when already at/above the target
// is a no-op success, not an error). A third, 100mi "exclusive" tier exists
// above this one (0012_radius_tiers.sql) but is intentionally NOT reachable
// from here — it's a manual grant for hand-picked participants, not
// something coins or levels can buy.
//
// 'extra_stops' — raises the caller's unlocked_stop_count from the free
// default of 3 up to EXTRA_STOPS_STOP_COUNT (5), unlocking the remaining
// stops on any route that has them. Free once the caller reaches Level 3
// (xp >= 200 — about 4 check-ins, so "earn it by playing"); otherwise costs
// EXTRA_STOPS_COST Adventure Coins (earned via xp_reward or bought via
// buy-coins/Stripe — "pay to play"). Permanent once unlocked.
//
// 'theme' — unlocks or switches a visual "skin" for the player-facing
// pages. action defaults to 'unlock' (checks the theme's unlock_method —
// free/level/coins — via unlock_theme() in 0008_themes.sql); pass
// action: 'activate' to switch the caller's active_theme_id to a theme
// they've already unlocked (or that's free). Both paths are enforced
// entirely inside the SQL functions, called here with the service role.
//
// All balance/unlock changes go through debit_coins()/direct profile
// updates/the theme RPCs, via the service role, which is the only role
// allowed to touch these columns (see the `revoke update (...)` in
// 0007_gamification.sql and 0008_themes.sql) — so this function is the
// single, auditable code path that can ever move a player's coin balance,
// unlock flags, or active theme.
//
// v10 addition: every successful unlock also awards the matching badge via
// award_badge() (0010_badges_and_adventures.sql). Awarding is idempotent,
// so it's called unconditionally on every success path, including the
// "already unlocked" no-op branches — that retroactively gives long-time
// players the badge for progress they made before badges existed, and is a
// no-op (no celebration) for anyone who already has it. The response's
// `newBadge` field is only set when the award was actually new, so the
// client only pops a celebration the first time.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined from ../_shared/cors.ts and ../_shared/supabaseAdmin.ts — the
// Supabase dashboard's single-function editor does not reliably bundle
// sibling _shared/*.ts files added via its "Add File" UI (reproducibly
// fails with "Module not found ... _shared/cors.ts" even when the files
// are present with correct names/content). Inlining sidesteps that bundler
// bug. The canonical source of truth for these helpers is still
// muso-backend/supabase/functions/_shared/*.ts — keep both in sync if
// either changes.

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

const UNLOCK_LEVEL = 5; // xp >= 400
const VENUE_SEARCH_COST = 250;
const RADIUS_UNLOCK_COST = 150;
const RADIUS_UNLOCK_MILES = 50; // exclusive 100mi tier is a manual grant, not unlockable here
const EXTRA_STOPS_LEVEL = 3; // xp >= 200
const EXTRA_STOPS_COST = 200;
const EXTRA_STOPS_STOP_COUNT = 5;

type Badge = { key: string; name: string; description: string; emoji: string };

async function awardBadge(
  admin: ReturnType<typeof getSupabaseAdmin>,
  profileId: string,
  key: string,
): Promise<Badge | null> {
  const { data: awardedNew } = await admin.rpc("award_badge", { p_profile_id: profileId, p_badge_key: key });
  if (!awardedNew) return null;
  const { data: badgeRow } = await admin
    .from("badges")
    .select("key, name, description, emoji")
    .eq("key", key)
    .single();
  return (badgeRow as Badge) ?? null;
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
    return jsonResponse({ error: "Sign in to unlock this." }, 401);
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

  const feature = body.feature;
  if (feature !== "venue_search" && feature !== "radius" && feature !== "theme" && feature !== "extra_stops") {
    return jsonResponse({ error: "feature must be 'venue_search', 'radius', 'extra_stops', or 'theme'" }, 400);
  }

  if (feature === "theme") {
    const themeId = typeof body.themeId === "string" ? body.themeId : null;
    if (!themeId) {
      return jsonResponse({ error: "themeId is required for feature 'theme'" }, 400);
    }
    const action = body.action === "activate" ? "activate" : "unlock";
    const rpcName = action === "activate" ? "activate_theme" : "unlock_theme";

    const { data, error } = await admin.rpc(rpcName, { p_profile_id: userId, p_theme_id: themeId });
    if (error) return jsonResponse({ error: error.message }, 400);
    if (!data?.ok) return jsonResponse({ error: data?.error ?? "Could not update theme." }, 402);

    const newBadge = action === "unlock" ? await awardBadge(admin, userId, "theme_unlocked") : null;
    return jsonResponse({ ok: true, ...data, newBadge });
  }

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("level, adventure_coins, unlocked_radius_miles, venues_search_unlocked, unlocked_stop_count")
    .eq("id", userId)
    .maybeSingle();

  if (profileErr || !profile) {
    return jsonResponse({ error: "Couldn't load your profile." }, 400);
  }

  if (feature === "venue_search") {
    if (profile.venues_search_unlocked) {
      const newBadge = await awardBadge(admin, userId, "venue_search_unlocked");
      return jsonResponse({ ok: true, alreadyUnlocked: true, unlocked: true, newBadge });
    }

    if ((profile.level ?? 1) >= UNLOCK_LEVEL) {
      const { error } = await admin
        .from("profiles")
        .update({ venues_search_unlocked: true })
        .eq("id", userId);
      if (error) return jsonResponse({ error: error.message }, 400);
      const newBadge = await awardBadge(admin, userId, "venue_search_unlocked");
      return jsonResponse({ ok: true, unlocked: true, method: "level", newBadge });
    }

    const { data: success, error } = await admin.rpc("debit_coins", {
      p_profile_id: userId,
      p_amount: VENUE_SEARCH_COST,
      p_reason: "unlock_venue_search",
    });
    if (error) return jsonResponse({ error: error.message }, 400);
    if (!success) {
      return jsonResponse(
        {
          error: `Not enough Adventure Coins. Need ${VENUE_SEARCH_COST}, you have ${profile.adventure_coins}. Reach Level ${UNLOCK_LEVEL} to unlock for free instead.`,
        },
        402,
      );
    }

    const { error: flagErr } = await admin
      .from("profiles")
      .update({ venues_search_unlocked: true })
      .eq("id", userId);
    if (flagErr) return jsonResponse({ error: flagErr.message }, 400);

    const newBadge = await awardBadge(admin, userId, "venue_search_unlocked");
    return jsonResponse({ ok: true, unlocked: true, method: "coins", spent: VENUE_SEARCH_COST, newBadge });
  }

  if (feature === "radius") {
    if ((profile.unlocked_radius_miles ?? 30) >= RADIUS_UNLOCK_MILES) {
      const newBadge = await awardBadge(admin, userId, "radius_unlocked");
      return jsonResponse({
        ok: true,
        alreadyUnlocked: true,
        unlockedRadiusMiles: profile.unlocked_radius_miles,
        newBadge,
      });
    }

    const { data: success, error } = await admin.rpc("debit_coins", {
      p_profile_id: userId,
      p_amount: RADIUS_UNLOCK_COST,
      p_reason: "unlock_radius",
    });
    if (error) return jsonResponse({ error: error.message }, 400);
    if (!success) {
      return jsonResponse(
        {
          error: `Not enough Adventure Coins. Need ${RADIUS_UNLOCK_COST}, you have ${profile.adventure_coins}.`,
        },
        402,
      );
    }

    const { error: radiusErr } = await admin
      .from("profiles")
      .update({ unlocked_radius_miles: RADIUS_UNLOCK_MILES })
      .eq("id", userId);
    if (radiusErr) return jsonResponse({ error: radiusErr.message }, 400);

    const newBadge = await awardBadge(admin, userId, "radius_unlocked");
    return jsonResponse({
      ok: true,
      unlockedRadiusMiles: RADIUS_UNLOCK_MILES,
      spent: RADIUS_UNLOCK_COST,
      newBadge,
    });
  }

  // feature === "extra_stops"
  if ((profile.unlocked_stop_count ?? 3) >= EXTRA_STOPS_STOP_COUNT) {
    const newBadge = await awardBadge(admin, userId, "extra_stops_unlocked");
    return jsonResponse({
      ok: true,
      alreadyUnlocked: true,
      unlockedStopCount: profile.unlocked_stop_count,
      newBadge,
    });
  }

  if ((profile.level ?? 1) >= EXTRA_STOPS_LEVEL) {
    const { error: levelErr } = await admin
      .from("profiles")
      .update({ unlocked_stop_count: EXTRA_STOPS_STOP_COUNT })
      .eq("id", userId);
    if (levelErr) return jsonResponse({ error: levelErr.message }, 400);
    const newBadge = await awardBadge(admin, userId, "extra_stops_unlocked");
    return jsonResponse({ ok: true, unlockedStopCount: EXTRA_STOPS_STOP_COUNT, method: "level", newBadge });
  }

  const { data: stopsSuccess, error: stopsDebitErr } = await admin.rpc("debit_coins", {
    p_profile_id: userId,
    p_amount: EXTRA_STOPS_COST,
    p_reason: "unlock_extra_stops",
  });
  if (stopsDebitErr) return jsonResponse({ error: stopsDebitErr.message }, 400);
  if (!stopsSuccess) {
    return jsonResponse(
      {
        error: `Not enough Adventure Coins. Need ${EXTRA_STOPS_COST}, you have ${profile.adventure_coins}. Reach Level ${EXTRA_STOPS_LEVEL} to unlock for free instead.`,
      },
      402,
    );
  }

  const { error: stopsErr } = await admin
    .from("profiles")
    .update({ unlocked_stop_count: EXTRA_STOPS_STOP_COUNT })
    .eq("id", userId);
  if (stopsErr) return jsonResponse({ error: stopsErr.message }, 400);

  const newBadge = await awardBadge(admin, userId, "extra_stops_unlocked");
  return jsonResponse({
    ok: true,
    unlockedStopCount: EXTRA_STOPS_STOP_COUNT,
    method: "coins",
    spent: EXTRA_STOPS_COST,
    newBadge,
  });
});
