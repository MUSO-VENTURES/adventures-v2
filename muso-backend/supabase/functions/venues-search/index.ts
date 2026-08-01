// GET /venues-search?startLat=&startLng=&radiusMiles=15&budget=$$&category=
//
// Finds top-rated real venues near a point via the Yelp Fusion API, sorted
// with featured (partner_tier 'premium'/'sponsor') venues first and rating
// descending after that, and upserts them into the `venues` table (keyed by
// yelp_id, via upsert_yelp_venues() in 0007_gamification.sql) so they can be
// wired into routes later. Returns the matched venues either way, even if
// the upsert fails for some of them, so the discovery UI always gets usable
// results.
//
// Gamification gate (0007_gamification.sql): "real" unlocked results only
// go to signed-in players who are Level 5+ (xp >= 400) or who've spent
// Adventure Coins to unlock the feature (see unlock-feature). Everyone else
// — including anonymous callers with no Authorization header — still gets a
// response with the same shape, just `unlocked: false`, so the client can
// render a locked teaser instead of a second, separate endpoint.
//
// radiusMiles is capped server-side at the caller's unlocked_radius_miles
// regardless of what's requested in the query string, so the paywall can't
// be bypassed by just asking for a bigger radius. Three tiers
// (0012_radius_tiers.sql): 30mi free by default, 50mi via unlock-feature's
// self-serve 'radius' unlock, 100mi "exclusive" tier via manual grant only
// OR a live, active MUSO Pass+ subscription (0013_muso_pass_subscriptions.sql)
// — checked fresh on every request from subscription_tier/subscription_status,
// NEVER written permanently to unlocked_radius_miles, so the 100mi bonus
// disappears the instant a Pass+ subscription lapses, same as any other
// subscription-only perk.
//
// Requires a YELP_API_KEY secret (Supabase dashboard > Edge Functions >
// Secrets, or `supabase secrets set YELP_API_KEY=...`). Get a free key at
// https://www.yelp.com/developers/v3/manage_app — the free tier covers a
// generous number of calls/day, no billing account required.
//
// startLat/startLng default to the Livermore, CA 94551 pin, same default
// used by discovery-submit, for callers that don't share geolocation.
// radiusMiles defaults to 15 and is clamped to Yelp's own hard cap (~24.85
// miles / 40,000 meters) regardless of what's requested, since Yelp's API
// won't search wider than that.

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

const DEFAULT_LAT = 37.6819;
const DEFAULT_LNG = -121.768;
const DEFAULT_RADIUS_MILES = 15;
const FREE_RADIUS_MILES = 30;
const UNLOCK_LEVEL = 5; // xp >= 400, see profiles.level in 0007_gamification.sql
const YELP_MAX_RADIUS_METERS = 40000; // ~24.85 miles, Yelp's hard cap
const PASS_PLUS_RADIUS_MILES = 100; // live-only bonus, see 0013_muso_pass_subscriptions.sql

const VALID_BUDGETS: Record<string, string> = {
  "$": "1",
  "$$": "1,2",
  "$$$": "1,2,3",
  "$$$$": "1,2,3,4",
};

type VenueRow = {
  yelp_id: string;
  name: string;
  category: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  phone: string | null;
  rating: number | null;
  rating_count: number | null;
  source_url: string | null;
  price: string | null;
  image_url: string | null;
  partner_tier: string;
  featured_position: number | null;
};

function milesToMeters(miles: number): number {
  return Math.round(miles * 1609.34);
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const yelpKey = Deno.env.get("YELP_API_KEY");
  if (!yelpKey) {
    return jsonResponse(
      { error: "YELP_API_KEY is not configured for this project yet." },
      501,
    );
  }

  const admin = getSupabaseAdmin();

  // ---- Who's calling, and are they unlocked? ----
  let unlocked = false;
  let unlockedRadiusMiles = FREE_RADIUS_MILES;

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (jwt) {
    const { data: userData } = await admin.auth.getUser(jwt);
    const userId = userData?.user?.id;
    if (userId) {
      const { data: profile } = await admin
        .from("profiles")
        .select("level, adventure_coins, unlocked_radius_miles, venues_search_unlocked, subscription_tier, subscription_status")
        .eq("id", userId)
        .maybeSingle();
      if (profile) {
        unlocked = profile.venues_search_unlocked === true || (profile.level ?? 1) >= UNLOCK_LEVEL;
        unlockedRadiusMiles = profile.unlocked_radius_miles ?? FREE_RADIUS_MILES;
        // Live-only 100mi bonus for an active Pass+ subscriber — deliberately
        // NOT persisted to unlocked_radius_miles, so it evaporates the moment
        // subscription_status stops being 'active' (cancellation, payment
        // failure, etc.), unlike every permanent unlock above.
        if (profile.subscription_tier === "pass_plus" && profile.subscription_status === "active") {
          unlockedRadiusMiles = Math.max(unlockedRadiusMiles, PASS_PLUS_RADIUS_MILES);
        }
      }
    }
  }

  const url = new URL(req.url);
  const startLat = Number(url.searchParams.get("startLat")) || DEFAULT_LAT;
  const startLng = Number(url.searchParams.get("startLng")) || DEFAULT_LNG;
  const radiusMilesParam = Number(url.searchParams.get("radiusMiles"));
  const requestedRadiusMiles = Number.isFinite(radiusMilesParam) && radiusMilesParam > 0
    ? radiusMilesParam
    : DEFAULT_RADIUS_MILES;
  // Hard server-side cap — can't be bypassed by editing the query string.
  const radiusMiles = Math.min(requestedRadiusMiles, unlockedRadiusMiles);
  const radiusMeters = Math.min(milesToMeters(radiusMiles), YELP_MAX_RADIUS_METERS);

  const budgetParam = url.searchParams.get("budget");
  const yelpPrice = budgetParam && VALID_BUDGETS[budgetParam] ? VALID_BUDGETS[budgetParam] : undefined;

  const category = url.searchParams.get("category") ?? undefined;
  const term = url.searchParams.get("term") ?? undefined;

  const yelpParams = new URLSearchParams({
    latitude: String(startLat),
    longitude: String(startLng),
    radius: String(radiusMeters),
    sort_by: "rating",
    limit: "20",
  });
  if (yelpPrice) yelpParams.set("price", yelpPrice);
  if (category) yelpParams.set("categories", category);
  if (term) yelpParams.set("term", term);

  let yelpData: Record<string, unknown>;
  try {
    const yelpRes = await fetch(
      `https://api.yelp.com/v3/businesses/search?${yelpParams.toString()}`,
      { headers: { Authorization: `Bearer ${yelpKey}` } },
    );
    if (!yelpRes.ok) {
      const errBody = await yelpRes.text();
      return jsonResponse(
        { error: `Yelp API error (${yelpRes.status}): ${errBody.slice(0, 300)}` },
        502,
      );
    }
    yelpData = await yelpRes.json();
  } catch (e) {
    return jsonResponse({ error: `Failed to reach Yelp: ${(e as Error).message}` }, 502);
  }

  const businesses = Array.isArray(yelpData.businesses) ? yelpData.businesses : [];

  const venues: VenueRow[] = businesses.map((b: Record<string, unknown>) => {
    const categories = Array.isArray(b.categories) ? b.categories as Record<string, unknown>[] : [];
    const coordinates = (b.coordinates ?? {}) as Record<string, unknown>;
    const location = (b.location ?? {}) as Record<string, unknown>;
    const displayAddress = Array.isArray(location.display_address)
      ? (location.display_address as string[]).join(", ")
      : null;

    return {
      yelp_id: b.id as string,
      name: b.name as string,
      category: categories[0]?.title as string | undefined ?? null,
      address: displayAddress,
      lat: coordinates.latitude as number | undefined ?? null,
      lng: coordinates.longitude as number | undefined ?? null,
      phone: (b.display_phone as string) || null,
      rating: (b.rating as number) ?? null,
      rating_count: (b.review_count as number) ?? null,
      source_url: (b.url as string)?.split("?")[0] ?? null,
      price: (b.price as string) ?? null,
      // Yelp's own business-submitted "hero" photo. Real, current photo of
      // the actual venue — not a stock image, and not guaranteed to show
      // patrons (Yelp has no "people" filter), but it's the best available
      // glamour shot without standing up a separate photo pipeline.
      image_url: (b.image_url as string) || null,
      // Defaults for a brand-new venue; overwritten below from the DB for
      // any venue that already has a curated partner_tier/featured_position.
      partner_tier: "basic",
      featured_position: null,
    };
  });

  // Upsert fresh Yelp data via the DB function, which is written to never
  // touch partner_tier/featured_position on existing rows — see
  // upsert_yelp_venues() in 0007_gamification.sql. A Yelp hiccup or a
  // missing column (pre-migration) shouldn't block returning results.
  try {
    const rows = venues.filter((v) => v.yelp_id && v.lat != null && v.lng != null);
    if (rows.length) {
      await admin.rpc("upsert_yelp_venues", { rows: JSON.stringify(rows) });

      const { data: existing } = await admin
        .from("venues")
        .select("yelp_id, partner_tier, featured_position")
        .in("yelp_id", rows.map((r) => r.yelp_id));
      const byYelpId = new Map((existing ?? []).map((v) => [v.yelp_id as string, v]));
      for (const v of venues) {
        const match = byYelpId.get(v.yelp_id);
        if (match) {
          v.partner_tier = (match.partner_tier as string) ?? "basic";
          v.featured_position = (match.featured_position as number | null) ?? null;
        }
      }
    }
  } catch {
    // Non-fatal — results still return with default partner_tier below.
  }

  // Featured (premium/sponsor) venues get priority inclusion anywhere in
  // the list, ahead of basic venues — paying/partner venues win a spot in
  // the route first. Ranked by rating within each group. Until real paid
  // venues exist this naturally collapses to "everyone's basic, sort by
  // rating," which is today's fallback behavior.
  const isFeatured = (v: VenueRow) => v.partner_tier === "premium" || v.partner_tier === "sponsor";
  const sorted = [...venues].sort((a, b) => {
    const aFeatured = isFeatured(a) ? 1 : 0;
    const bFeatured = isFeatured(b) ? 1 : 0;
    if (aFeatured !== bFeatured) return bFeatured - aFeatured;
    return (b.rating ?? 0) - (a.rating ?? 0);
  });

  return jsonResponse({
    venues: sorted,
    unlocked,
    unlockedRadiusMiles,
    searchedRadiusMiles: Math.round(radiusMeters / 1609.34 * 10) / 10,
    budget: budgetParam ?? null,
  });
});
