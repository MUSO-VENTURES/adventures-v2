// POST /discovery-submit
// Body matches the landing page's Quick/Full discovery form:
// { partyId?, mode, budget, contentRating, alcoholPref, interests?, occasion?,
//   groupSize?, notes?, startLat?, startLng?, radiusMiles?, birthDate?,
//   disclaimerAccepted? }
//
// startLat/startLng default to the Livermore, CA 94551 pin (37.6819, -121.768)
// when the client doesn't supply a location (e.g. geolocation denied, or the
// player just hasn't chosen a pin yet). radiusMiles defaults to 25 and is
// capped at 200. Routes whose stops (with a known venue) all fall within the
// radius of the chosen pin come back as suggestedRoutes, so the UI can show
// only in-range itineraries.
//
// Age gate / disclaimer: disclaimerAccepted must be true on every request —
// routes can involve alcohol and physical activities regardless of content
// rating. birthDate (YYYY-MM-DD) must be present and valid on every request
// too — age is computed from it server-side rather than trusted from an
// unverified checkbox, and the birthday itself is stored so it can be used
// for birthday-special promotions later.
//
// Two-tier content rating gate: NC-17 requires 18+, Adults Only requires
// 21+ (routes involving bars/dispensaries — no lower carve-out for that
// tier). This mirrors the database CHECK constraints added in
// 0004_venue_search_and_age_gate.sql / 0006_birthday_capture.sql, so it's
// enforced twice: here (clear error message for the client) and again at
// the DB layer (belt and suspenders — no code path can bypass it, including
// future functions). age_confirmed stored on the row means "the caller met
// whatever age bar their chosen contentRating required" — not a flat 21+ —
// so it stays compatible with the DB constraint, which only checks that
// flag is true whenever contentRating is adult-tier.
//
// Open to unauthenticated visitors too (a planner might fill this out before
// creating an account), so it uses the admin client but validates the shape
// tightly rather than relying on RLS to catch bad input.

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

const VALID_BUDGETS = ["$", "$$", "$$$", "$$$$"];
const VALID_RATINGS = ["G-Rated", "PG-Rated", "NC-17", "Adults Only"];
const VALID_ALCOHOL = ["Alcohol-Friendly", "Sober / Alcohol-Free"];
const MIN_NC17_AGE = 18;
const MIN_ADULTS_ONLY_AGE = 21;

// Default pin: Livermore, CA 94551
const DEFAULT_LAT = 37.6819;
const DEFAULT_LNG = -121.768;
const DEFAULT_RADIUS_MILES = 25;
const MAX_RADIUS_MILES = 200;

const BIRTH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Computes age in whole years from a YYYY-MM-DD string, using UTC to avoid
// timezone edge cases shifting someone's birthday by a day. Returns null for
// anything unparsable, in the future, or implausibly old (120+).
function calculateAge(birthDateStr: string): number | null {
  if (!BIRTH_DATE_RE.test(birthDateStr)) return null;
  const birthDate = new Date(`${birthDateStr}T00:00:00Z`);
  if (Number.isNaN(birthDate.getTime())) return null;

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (birthDate.getTime() > today.getTime()) return null; // future date

  let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = today.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < birthDate.getUTCDate())) {
    age--;
  }
  return age >= 0 && age <= 120 ? age : null;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const mode = body.mode === "full" ? "full" : "quick";

  if (body.budget && !VALID_BUDGETS.includes(body.budget as string)) {
    return jsonResponse({ error: "Invalid budget value" }, 400);
  }
  if (body.contentRating && !VALID_RATINGS.includes(body.contentRating as string)) {
    return jsonResponse({ error: "Invalid contentRating value" }, 400);
  }
  if (body.alcoholPref && !VALID_ALCOHOL.includes(body.alcoholPref as string)) {
    return jsonResponse({ error: "Invalid alcoholPref value" }, 400);
  }

  const disclaimerAccepted = body.disclaimerAccepted === true;
  if (!disclaimerAccepted) {
    return jsonResponse(
      { error: "You must accept the participant disclaimer before continuing." },
      400,
    );
  }

  const birthDateRaw = typeof body.birthDate === "string" ? body.birthDate : null;
  const age = birthDateRaw ? calculateAge(birthDateRaw) : null;
  if (!birthDateRaw || age === null) {
    return jsonResponse(
      { error: "Please enter a valid birth date to continue." },
      400,
    );
  }

  const contentRating = body.contentRating as string | undefined;
  const requiredAge = contentRating === "Adults Only" ? MIN_ADULTS_ONLY_AGE
    : contentRating === "NC-17" ? MIN_NC17_AGE
    : null;
  const ageConfirmed = requiredAge === null ? true : age >= requiredAge;
  if (requiredAge !== null && !ageConfirmed) {
    return jsonResponse(
      { error: `You must be ${requiredAge} or older to select this content rating.` },
      400,
    );
  }

  const startLat = typeof body.startLat === "number" && Number.isFinite(body.startLat) ? body.startLat : DEFAULT_LAT;
  const startLng = typeof body.startLng === "number" && Number.isFinite(body.startLng) ? body.startLng : DEFAULT_LNG;

  let radiusMiles = typeof body.radiusMiles === "number" ? body.radiusMiles : DEFAULT_RADIUS_MILES;
  if (!Number.isFinite(radiusMiles) || radiusMiles <= 0) {
    radiusMiles = DEFAULT_RADIUS_MILES;
  }
  radiusMiles = Math.min(Math.round(radiusMiles), MAX_RADIUS_MILES);

  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from("discovery_responses")
    .insert({
      party_id: body.partyId ?? null,
      mode,
      budget: body.budget ?? null,
      content_rating: body.contentRating ?? null,
      alcohol_pref: body.alcoholPref ?? null,
      interests: Array.isArray(body.interests) ? body.interests : null,
      occasion: body.occasion ?? null,
      group_size: body.groupSize ? Number(body.groupSize) : null,
      notes: typeof body.notes === "string" ? body.notes.slice(0, 2000) : null,
      start_lat: startLat,
      start_lng: startLng,
      radius_miles: radiusMiles,
      birth_date: birthDateRaw,
      age_confirmed: ageConfirmed,
      disclaimer_accepted: disclaimerAccepted,
      disclaimer_accepted_at: new Date().toISOString(),
    })
    .select()
    .single();

  if (error) {
    return jsonResponse({ error: error.message }, 400);
  }

  const { data: suggestedRoutes, error: routesErr } = await admin.rpc("routes_within_radius", {
    p_start_lat: startLat,
    p_start_lng: startLng,
    p_radius_miles: radiusMiles,
  });

  if (routesErr) {
    // A radius-search failure shouldn't block the discovery response itself.
    return jsonResponse(
      { discoveryResponse: data, suggestedRoutes: [], radiusWarning: routesErr.message },
      201,
    );
  }

  return jsonResponse({ discoveryResponse: data, suggestedRoutes: suggestedRoutes ?? [] }, 201);
});
