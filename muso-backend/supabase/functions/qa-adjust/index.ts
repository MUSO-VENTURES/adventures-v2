// POST /qa-adjust
//
// Internal QA-only tool. Lets the /sandbox/ page (an unlisted, stripped-down
// clone of preview/index.html used strictly for realtime-gameplay QA)
// directly set/reset a signed-in test account's gamification state instead
// of grinding it out normally. NEVER linked from the real app or marketing
// site — reachable only by whoever has the sandbox URL and the QA secret.
//
// Auth model (two independent checks, both required):
//   1. Authorization: Bearer <supabase user JWT> — must be a real signed-in
//      account (verified via admin.auth.getUser(token)). All mutations only
//      ever touch that caller's own profile_id — this function can never be
//      used to edit someone else's account.
//   2. x-qa-secret header — must match the QA_SECRET edge function secret.
//      This is the actual gate: without it, a signed-in player who somehow
//      found this endpoint's URL still can't call it. Set via
//      Supabase Dashboard > Edge Functions > qa-adjust > Secrets (or the
//      project-wide secrets list), then bake the same value into
//      sandbox/index.html's QA_SECRET constant.
//
// Runs entirely on the service role because xp / adventure_coins /
// unlocked_radius_miles / venues_search_unlocked / unlocked_stop_count are
// all `revoke update ... from authenticated` (0007_gamification.sql /
// 0011_stop_unlock.sql) — direct client writes to those columns are
// impossible by design, on purpose, everywhere except here.
//
// Body: { action: string, qaSecret omitted — sent as x-qa-secret header, ... }
//   set_xp          { xp: number }               absolute set, not additive
//   set_coins       { coins: number }             absolute set, not additive
//   reset_unlocks   {}                            unlocked_stop_count -> 3,
//                                                  unlocked_radius_miles -> 30,
//                                                  venues_search_unlocked -> false
//   clear_adventure {}                            abandons any in_progress
//                                                  adventure for the caller's
//                                                  party/parties
//   grant_badge     { badgeKey: string }          award_badge() RPC
//   clear_badges    { badgeKey?: string }         delete one (or, with no
//                                                  badgeKey, all) earned
//                                                  badges for the caller

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
    "authorization, x-client-info, apikey, content-type, x-qa-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

const MAX_XP = 1_000_000;
const MAX_COINS = 1_000_000;

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const qaSecretExpected = Deno.env.get("QA_SECRET");
  const qaSecretProvided = req.headers.get("x-qa-secret");
  if (!qaSecretExpected) {
    return jsonResponse({ error: "QA_SECRET is not configured on the server" }, 500);
  }
  if (!qaSecretProvided || qaSecretProvided !== qaSecretExpected) {
    return jsonResponse({ error: "Invalid or missing QA secret" }, 403);
  }

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) {
    return jsonResponse({ error: "Missing Authorization bearer token" }, 401);
  }

  const admin = getSupabaseAdmin();

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "Invalid or expired session" }, 401);
  }
  const profileId = userData.user.id;

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action as string | undefined;

  try {
    switch (action) {
      case "set_xp": {
        let xp = Number(body.xp);
        if (!Number.isFinite(xp) || xp < 0) {
          return jsonResponse({ error: "xp must be a non-negative number" }, 400);
        }
        xp = Math.min(Math.round(xp), MAX_XP);
        const { data, error } = await admin
          .from("profiles")
          .update({ xp })
          .eq("id", profileId)
          .select("xp, level")
          .single();
        if (error) throw error;
        return jsonResponse({ ok: true, profile: data });
      }

      case "set_coins": {
        let coins = Number(body.coins);
        if (!Number.isFinite(coins) || coins < 0) {
          return jsonResponse({ error: "coins must be a non-negative number" }, 400);
        }
        coins = Math.min(Math.round(coins), MAX_COINS);
        const { data, error } = await admin
          .from("profiles")
          .update({ adventure_coins: coins })
          .eq("id", profileId)
          .select("adventure_coins")
          .single();
        if (error) throw error;
        return jsonResponse({ ok: true, profile: data });
      }

      case "reset_unlocks": {
        const { data, error } = await admin
          .from("profiles")
          .update({
            unlocked_stop_count: 3,
            unlocked_radius_miles: 30,
            venues_search_unlocked: false,
          })
          .eq("id", profileId)
          .select("unlocked_stop_count, unlocked_radius_miles, venues_search_unlocked")
          .single();
        if (error) throw error;
        return jsonResponse({ ok: true, profile: data });
      }

      case "clear_adventure": {
        const { data: memberRows, error: memberErr } = await admin
          .from("party_members")
          .select("party_id")
          .eq("profile_id", profileId);
        if (memberErr) throw memberErr;
        const partyIds = (memberRows || []).map((r) => r.party_id);
        if (!partyIds.length) {
          return jsonResponse({ ok: true, clearedAdventureIds: [] });
        }

        const { data: advRows, error: advSelErr } = await admin
          .from("adventures")
          .select("id")
          .in("party_id", partyIds)
          .eq("status", "in_progress");
        if (advSelErr) throw advSelErr;
        const advIds = (advRows || []).map((r) => r.id);
        if (!advIds.length) {
          return jsonResponse({ ok: true, clearedAdventureIds: [] });
        }

        const { error: updErr } = await admin
          .from("adventures")
          .update({ status: "abandoned" })
          .in("id", advIds);
        if (updErr) throw updErr;

        return jsonResponse({ ok: true, clearedAdventureIds: advIds });
      }

      case "grant_badge": {
        const badgeKey = body.badgeKey as string | undefined;
        if (!badgeKey) {
          return jsonResponse({ error: "badgeKey is required" }, 400);
        }
        const { data, error } = await admin.rpc("award_badge", {
          p_profile_id: profileId,
          p_badge_key: badgeKey,
          p_meta: {},
        });
        if (error) throw error;
        return jsonResponse({ ok: true, newlyAwarded: data });
      }

      case "clear_badges": {
        const badgeKey = body.badgeKey as string | undefined;
        let query = admin.from("profile_badges").delete().eq("profile_id", profileId);
        if (badgeKey) query = query.eq("badge_key", badgeKey);
        const { error } = await query;
        if (error) throw error;
        return jsonResponse({ ok: true });
      }

      default:
        return jsonResponse({ error: `Unknown action: ${action}` }, 400);
    }
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});
