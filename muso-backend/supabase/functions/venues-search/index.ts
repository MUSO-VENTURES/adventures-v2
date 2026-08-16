// GET /venues-search?startLat=&startLng=&radiusMiles=15&budget=$$&category=
//
// Finds top-rated real venues near a point via Google Places API (New),
// sorted with featured (partner_tier 'premium'/'sponsor') venues first and
// rating descending after that, and upserts them into the `venues` table
// (keyed by google_place_id, via upsert_places_venues() in
// 0037_google_places_migration.sql) so they can be wired into routes
// later. Returns the matched venues either way, even if the upsert fails
// for some of them, so the discovery UI always gets usable results.
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
// Requires two secrets (Supabase dashboard > Edge Functions > Secrets, or
// `supabase secrets set NAME=value`):
//   GOOGLE_PLACES_SERVER_KEY — used for the Nearby Search call itself.
//     Restrict this key's API access to "Places API (New)" only; leave its
//     application restriction as "None" (Supabase Edge Functions don't have
//     a fixed outbound IP on most plans, so IP restriction isn't viable —
//     the API restriction is the real protection here).
//   GOOGLE_PLACES_PHOTO_KEY — embedded directly in the image_url values
//     returned to players (Google's Photo Media endpoint takes the key as
//     a query param). Restrict this one by HTTP referrer to your own
//     domain(s), since it's visible in the browser.
// Requires billing enabled on the Google Cloud project either way — there's
// no billing-free tier, only free monthly usage credit against a card on
// file. See console.cloud.google.com/apis/library/places.googleapis.com.
//
// startLat/startLng default to the Livermore, CA 94551 pin, same default
// used by discovery-submit, for callers that don't share geolocation.
// radiusMiles defaults to 15 and is clamped to Google Places (New)'s own
// hard cap (50,000 meters / ~31 miles) regardless of what's requested.

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
const PLACES_MAX_RADIUS_METERS = 50000; // Google Places (New) Nearby Search hard cap
const PASS_PLUS_RADIUS_MILES = 100; // live-only bonus, see 0013_muso_pass_subscriptions.sql

const VALID_BUDGETS: Record<string, string[]> = {
  "$": ["PRICE_LEVEL_INEXPENSIVE"],
  "$$": ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE"],
  "$$$": ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE"],
  "$$$$": ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"],
};

// Google's priceLevel enum -> the $/$$/$$$/$$$$ display string the (QA-tool)
// frontend expects. Never persisted to the venues table, display-only.
const PRICE_LEVEL_DISPLAY: Record<string, string> = {
  PRICE_LEVEL_FREE: "",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

type VenueRow = {
  google_place_id: string;
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
  hours: unknown;
  partner_tier: string;
  featured_position: number | null;
};

function milesToMeters(miles: number): number {
  return Math.round(miles * 1609.34);
}

// Kept byte-compatible with real-venue-adventure/index.ts's VenueHours
// shape (day 0=Monday..6=Sunday, "HHMM" strings) — see that file's
// googleHoursToVenueHours() for the full rationale. Duplicated here rather
// than shared since this function can't import from a sibling file (see
// the inlining note above).
function googleHoursToVenueHours(hours: { openNow?: boolean; periods?: { open: { day: number; hour: number; minute: number }; close?: { day: number; hour: number; minute: number } }[] } | null | undefined) {
  if (!hours || !Array.isArray(hours.periods)) return null;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const toInternalDay = (googleDay: number) => (googleDay + 6) % 7;
  const open = hours.periods
    .filter((p) => p.open && p.close)
    .map((p) => ({
      day: toInternalDay(p.open.day),
      start: `${pad2(p.open.hour)}${pad2(p.open.minute)}`,
      end: `${pad2(p.close!.hour)}${pad2(p.close!.minute)}`,
      is_overnight: p.close!.day !== p.open.day,
    }));
  return [{ hour_type: "REGULAR", is_open_now: !!hours.openNow, open }];
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const placesServerKey = Deno.env.get("GOOGLE_PLACES_SERVER_KEY");
  if (!placesServerKey) {
    return jsonResponse(
      { error: "GOOGLE_PLACES_SERVER_KEY is not configured for this project yet." },
      501,
    );
  }
  const placesPhotoKey = Deno.env.get("GOOGLE_PLACES_PHOTO_KEY");
  if (!placesPhotoKey) {
    return jsonResponse(
      { error: "GOOGLE_PLACES_PHOTO_KEY is not configured for this project yet." },
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
  const radiusMeters = Math.min(milesToMeters(radiusMiles), PLACES_MAX_RADIUS_METERS);

  const budgetParam = url.searchParams.get("budget");
  const priceLevels = budgetParam && VALID_BUDGETS[budgetParam] ? VALID_BUDGETS[budgetParam] : undefined;

  // "category" arrives as a single Google place-type string (or comma-
  // separated list) from the caller — passed straight through as
  // includedTypes. "term" (free-text search) has no Nearby Search
  // equivalent in Places API (New); Text Search (New) would be the
  // provider-side fit if free-text search is needed again later, but
  // nothing currently sends `term` from the frontend.
  const category = url.searchParams.get("category") ?? undefined;
  const includedTypes = category ? category.split(",").map((c) => c.trim()).filter(Boolean) : undefined;

  const requestBody: Record<string, unknown> = {
    locationRestriction: { circle: { center: { latitude: startLat, longitude: startLng }, radius: radiusMeters } },
    maxResultCount: 20,
    rankPreference: "POPULARITY", // closest available proxy for Yelp's old sort_by=rating — Places (New) has no literal rating-sort
  };
  if (includedTypes?.length) requestBody.includedTypes = includedTypes;
  if (priceLevels) requestBody.priceLevels = priceLevels;

  let placesData: Record<string, unknown>;
  try {
    const placesRes = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": placesServerKey,
        "X-Goog-FieldMask": [
          "places.id", "places.displayName", "places.rating", "places.userRatingCount",
          "places.formattedAddress", "places.location", "places.photos",
          "places.regularOpeningHours", "places.primaryType", "places.nationalPhoneNumber",
          "places.googleMapsUri", "places.priceLevel",
        ].join(","),
      },
      body: JSON.stringify(requestBody),
    });
    if (!placesRes.ok) {
      const errBody = await placesRes.text();
      return jsonResponse(
        { error: `Google Places API error (${placesRes.status}): ${errBody.slice(0, 300)}` },
        502,
      );
    }
    placesData = await placesRes.json();
  } catch (e) {
    return jsonResponse({ error: `Failed to reach Google Places: ${(e as Error).message}` }, 502);
  }

  const places = Array.isArray(placesData.places) ? placesData.places : [];

  const venues: VenueRow[] = places.map((p: Record<string, unknown>) => {
    const location = (p.location ?? {}) as Record<string, unknown>;
    const photos = Array.isArray(p.photos) ? p.photos as Record<string, unknown>[] : [];
    const photoName = photos[0]?.name as string | undefined;
    const primaryType = p.primaryType as string | undefined;
    const priceLevel = p.priceLevel as string | undefined;

    return {
      google_place_id: p.id as string,
      name: (p.displayName as Record<string, unknown> | undefined)?.text as string | undefined,
      // Underscore-to-space, matching real-venue-adventure/index.ts's same
      // conversion — keeps this display text reading like Yelp's old
      // space-separated category titles ("wine_bar" -> "wine bar").
      category: primaryType ? primaryType.replace(/_/g, " ") : null,
      address: (p.formattedAddress as string) || null,
      lat: (location.latitude as number | undefined) ?? null,
      lng: (location.longitude as number | undefined) ?? null,
      phone: (p.nationalPhoneNumber as string) || null,
      rating: (p.rating as number) ?? null,
      rating_count: (p.userRatingCount as number) ?? null,
      source_url: (p.googleMapsUri as string) || null,
      price: priceLevel ? (PRICE_LEVEL_DISPLAY[priceLevel] ?? null) : null,
      // Ready-to-use, no-extra-call image URL — the Photo Media endpoint
      // redirects straight to the actual image when hit. Uses the
      // referrer-restricted photo key (not the server key) since this URL
      // is shown directly in players' browsers.
      image_url: photoName
        ? `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&key=${placesPhotoKey}`
        : null,
      hours: googleHoursToVenueHours(p.regularOpeningHours as never),
      // Defaults for a brand-new venue; overwritten below from the DB for
      // any venue that already has a curated partner_tier/featured_position.
      partner_tier: "basic",
      featured_position: null,
    };
  }).filter((v: VenueRow) => v.google_place_id && v.name);

  // Upsert fresh Places data via the DB function, which is written to
  // never touch partner_tier/featured_position on existing rows — see
  // upsert_places_venues() in 0037_google_places_migration.sql. A Places
  // hiccup or a missing column (pre-migration) shouldn't block returning
  // results.
  try {
    const rows = venues.filter((v) => v.google_place_id && v.lat != null && v.lng != null);
    if (rows.length) {
      // Plain array, not JSON.stringify(rows) — the SQL function's
      // `rows jsonb` parameter needs a genuine JSONB array. Stringifying
      // double-encodes it into a JSONB scalar, which fails inside the
      // function's jsonb_array_elements(rows) call. See the matching fix
      // (and full explanation) in real-venue-adventure/index.ts.
      await admin.rpc("upsert_places_venues", { rows });

      const { data: existing } = await admin
        .from("venues")
        .select("google_place_id, partner_tier, featured_position")
        .in("google_place_id", rows.map((r) => r.google_place_id));
      const byPlaceId = new Map((existing ?? []).map((v) => [v.google_place_id as string, v]));
      for (const v of venues) {
        const match = byPlaceId.get(v.google_place_id);
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
