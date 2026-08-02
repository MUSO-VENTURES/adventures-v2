// POST /real-venue-adventure
// Body: { action: 'init', partyId: string, lat: number, lng: number }
//     | { action: 'reroll', routeStopId: string }
//     | { action: 'advance', adventureId: string, lat: number, lng: number }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Backs "Chance Your Luck" real-venue adventures: instead of picking a
// curator-authored route, a party's stops are assembled on the fly from
// live nearby venues (matched to the player's saved profiles.preferences),
// one stop at a time. Every stop is represented as an ordinary routes +
// route_stops row (owner_party_id scopes it private to the creating party —
// see 0016_real_venue_adventures.sql), so the existing checkin/route-detail
// edge functions, and all the XP/badge/coin/photo-booth/progress-map UI
// built on top of them, work completely unmodified — verified by reading
// checkin/index.ts in full during planning. This function's only job is to
// create/update those rows correctly.
//
// Progressive reveal + premature-completion fix: checkin marks an adventure
// "completed" the moment check_ins count >= route_stops count for its
// route. Curated routes have every stop pre-authored, so that's correct.
// A real-venue route doesn't know stop 2's venue until the player has
// checked into stop 1 and shared their new location — so `init` instead
// pre-creates ALL of the party's target stop_count as placeholder rows
// up front (is_mystery = true, venue_id = null, reusing the exact same
// "Unknown Location" masking route-detail already does for curator-authored
// mystery stops), and only stop 1 is immediately revealed. `advance` then
// fills in the next placeholder in place (UPDATE, not INSERT) once the
// player reaches it. route_stops count is therefore correct — equal to the
// target stop count — from the moment `init` returns, so checkin's
// completion math is never wrong, and the target stop count is
// automatically enforced (advance simply has nothing left to fill once
// every placeholder is revealed).
//
// Server-side trust: preferences are always re-read fresh from the caller's
// own profile row, never taken from the request body — a player can't spoof
// someone else's budget/content-rating to search a wider net than they've
// unlocked.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined rather than imported from ../_shared/*.ts — the Supabase
// dashboard's single-function editor does not reliably bundle sibling files
// added via its "Add File" UI (reproducibly fails with "Module not found").
// Canonical source of truth for these helpers is still
// muso-backend/supabase/functions/_shared/*.ts — keep both in sync.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
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

type Admin = ReturnType<typeof getSupabaseAdmin>;

// ---------------------------------------------------------------
// Yelp search + preference-driven filtering
// (budget/interest mappings mirror venues-search/index.ts and index.html's
// INTEREST_YELP_CATEGORIES exactly, so a player sees the same kind of
// results here as they would from "Find Real Venues.")
// ---------------------------------------------------------------

const DEFAULT_RADIUS_MILES = 15;
const YELP_MAX_RADIUS_METERS = 40000; // ~24.85 miles, Yelp's hard cap
const FREE_REROLLS = 3;
const EXTRA_ROLL_COST = 20;

const VALID_BUDGETS: Record<string, string> = {
  "$": "1",
  "$$": "1,2",
  "$$$": "1,2,3",
  "$$$$": "1,2,3,4",
};

const INTEREST_YELP_CATEGORIES: Record<string, string> = {
  "Food & Drink": "restaurants,bars",
  "Outdoors": "parks,hiking",
  "Arts & Culture": "arts,museums,theater",
  "Games & Competition": "arcades,bowling,escapegames,minigolf,gokarts,axethrowing",
  "Live Music": "musicvenues,jazzandblues",
  "Wellness": "spas,yoga",
  "Nightlife": "nightlife,cocktailbars",
  "Shopping": "shopping",
  "Pet-Friendly": "dog_parks,petstores,zoos,aquariums",
  "Comedy": "comedyclubs",
  "Cultured": "opera,theater,artmuseums,galleries",
  "Oddities & Curiosities": "museums",
  "Smoke & Cigar": "hookahbars,cigarbars,vapeshops,tobaccoshops",
};

// Best-effort only — Yelp has no maturity/content field, so this just
// steers a family-safe profile away from bar-centric categories. Not a
// substitute for the client-side age gate, which is the real enforcement.
const NOT_FAMILY_SAFE_CATEGORIES = new Set([
  "bars", "nightlife", "cocktailbars", "hookahbars", "cigarbars", "vapeshops", "tobaccoshops",
]);

type Preferences = {
  budget?: string;
  radiusMiles?: number;
  contentRating?: string;
  alcohol?: string;
  interests?: string[];
};

function resolveYelpCategories(prefs: Preferences): string[] {
  const interests = prefs.interests ?? [];
  let categories = [...new Set(
    interests.flatMap((v) => (INTEREST_YELP_CATEGORIES[v] ?? "").split(",").filter(Boolean)),
  )];
  const familySafe = prefs.alcohol === "Sober / Alcohol-Free"
    || prefs.contentRating === "G-Rated"
    || prefs.contentRating === "PG-Rated";
  if (familySafe) {
    categories = categories.filter((c) => !NOT_FAMILY_SAFE_CATEGORIES.has(c));
  }
  return categories;
}

function milesToMeters(miles: number): number {
  return Math.round(miles * 1609.34);
}

type Candidate = {
  id: string;
  name: string;
  category: string | null;
  address: string | null;
  lat: number;
  lng: number;
  rating: number | null;
  image_url: string | null;
  partner_tier: string;
  distance_miles: number;
};

// Runs a live Yelp search, upserts results into `venues` (via the existing
// upsert_yelp_venues RPC, same as venues-search), then asks
// nearby_candidate_venues() (0016_real_venue_adventures.sql) for the
// distance-sorted, DB-merged (real partner_tier) result set. Returns []
// (never throws) on any Yelp-side failure — a network hiccup shouldn't
// crash init/advance, it should just come back with "no venues found."
async function searchNearbyVenues(
  admin: Admin,
  yelpKey: string,
  opts: { lat: number; lng: number; radiusMiles: number; budget?: string; categories: string[] },
): Promise<Candidate[]> {
  const radiusMeters = Math.min(milesToMeters(opts.radiusMiles), YELP_MAX_RADIUS_METERS);
  const yelpParams = new URLSearchParams({
    latitude: String(opts.lat),
    longitude: String(opts.lng),
    radius: String(radiusMeters),
    sort_by: "distance",
    limit: "20",
  });
  const yelpPrice = opts.budget && VALID_BUDGETS[opts.budget] ? VALID_BUDGETS[opts.budget] : undefined;
  if (yelpPrice) yelpParams.set("price", yelpPrice);
  if (opts.categories.length) yelpParams.set("categories", opts.categories.join(","));

  let businesses: Record<string, unknown>[];
  try {
    const yelpRes = await fetch(
      `https://api.yelp.com/v3/businesses/search?${yelpParams.toString()}`,
      { headers: { Authorization: `Bearer ${yelpKey}` } },
    );
    if (!yelpRes.ok) return [];
    const yelpData = await yelpRes.json();
    businesses = Array.isArray(yelpData.businesses) ? yelpData.businesses : [];
  } catch {
    return [];
  }

  const rows = businesses.map((b) => {
    const categories = Array.isArray(b.categories) ? b.categories as Record<string, unknown>[] : [];
    const coordinates = (b.coordinates ?? {}) as Record<string, unknown>;
    const location = (b.location ?? {}) as Record<string, unknown>;
    const displayAddress = Array.isArray(location.display_address)
      ? (location.display_address as string[]).join(", ")
      : null;
    return {
      yelp_id: b.id as string,
      name: b.name as string,
      category: (categories[0]?.title as string | undefined) ?? null,
      address: displayAddress,
      lat: (coordinates.latitude as number | undefined) ?? null,
      lng: (coordinates.longitude as number | undefined) ?? null,
      phone: (b.display_phone as string) || null,
      rating: (b.rating as number) ?? null,
      rating_count: (b.review_count as number) ?? null,
      source_url: (b.url as string)?.split("?")[0] ?? null,
      image_url: (b.image_url as string) || null,
    };
  }).filter((r) => r.yelp_id && r.lat != null && r.lng != null);

  if (!rows.length) return [];

  try {
    await admin.rpc("upsert_yelp_venues", { rows: JSON.stringify(rows) });
  } catch {
    return [];
  }

  const { data: candidates } = await admin.rpc("nearby_candidate_venues", {
    p_lat: opts.lat,
    p_lng: opts.lng,
    p_radius_miles: opts.radiusMiles,
    p_yelp_ids: rows.map((r) => r.yelp_id),
  });

  return (candidates ?? []) as Candidate[];
}

function weightedRandomPick(candidates: Candidate[]): Candidate {
  const isFeatured = (c: Candidate) => c.partner_tier === "premium" || c.partner_tier === "sponsor";
  const weights = candidates.map((c) => (isFeatured(c) ? 3 : 1));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------
// Shared loaders
// ---------------------------------------------------------------

async function getCallerProfile(admin: Admin, userId: string) {
  const { data } = await admin
    .from("profiles")
    .select("preferences, unlocked_radius_miles, unlocked_stop_count")
    .eq("id", userId)
    .maybeSingle();
  return data;
}

async function isPartyMember(admin: Admin, partyId: string, userId: string): Promise<boolean> {
  const { data } = await admin
    .from("party_members")
    .select("profile_id")
    .eq("party_id", partyId)
    .eq("profile_id", userId)
    .maybeSingle();
  return !!data;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const yelpKey = Deno.env.get("YELP_API_KEY");
  if (!yelpKey) {
    return jsonResponse({ error: "YELP_API_KEY is not configured for this project yet." }, 501);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) {
    return jsonResponse({ error: "Sign in to start a real-venue adventure." }, 401);
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

  // ---------------------------------------------------------------
  // init — creates the route + all placeholder stops, reveals stop 1
  // ---------------------------------------------------------------
  if (action === "init") {
    const partyId = typeof body.partyId === "string" ? body.partyId : null;
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!partyId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return jsonResponse({ error: "partyId, lat, and lng are required" }, 400);
    }
    if (!(await isPartyMember(admin, partyId, userId))) {
      return jsonResponse({ error: "You're not a member of that party." }, 403);
    }

    const profile = await getCallerProfile(admin, userId);
    if (!profile) return jsonResponse({ error: "Couldn't load your profile." }, 400);

    const prefs = (profile.preferences ?? {}) as Preferences;
    if (!Object.keys(prefs).length) {
      return jsonResponse({ error: "Set your preferences before starting a real-venue adventure." }, 400);
    }

    const radiusMiles = Math.min(prefs.radiusMiles || DEFAULT_RADIUS_MILES, profile.unlocked_radius_miles ?? DEFAULT_RADIUS_MILES);
    const categories = resolveYelpCategories(prefs);

    const candidates = await searchNearbyVenues(admin, yelpKey, {
      lat, lng, radiusMiles, budget: prefs.budget, categories,
    });
    if (!candidates.length) {
      return jsonResponse({ error: "No matching venues found nearby — try widening your search radius in preferences." }, 404);
    }

    const stopCount = profile.unlocked_stop_count ?? 3;
    const first = candidates[0];
    const remainingPool = candidates.slice(1);

    const { data: route, error: routeErr } = await admin
      .from("routes")
      .insert({
        owner_party_id: partyId,
        twist_key: "real-auto",
        title: "Real Venues Adventure",
        description: "Auto-picked from real, live venues near you — chance your luck to reroll.",
      })
      .select("id")
      .single();
    if (routeErr || !route) return jsonResponse({ error: routeErr?.message ?? "Could not create route" }, 400);

    const stopRows = [
      {
        route_id: route.id,
        venue_id: first.id,
        stop_order: 1,
        name: first.name,
        description: [first.category, first.address].filter(Boolean).join(" · "),
        is_mystery: false,
        candidate_pool: remainingPool,
      },
      ...Array.from({ length: Math.max(stopCount - 1, 0) }, (_, i) => ({
        route_id: route.id,
        venue_id: null,
        stop_order: i + 2,
        name: "Next Stop",
        description: null,
        is_mystery: true,
        candidate_pool: null,
      })),
    ];

    const { data: stops, error: stopsErr } = await admin
      .from("route_stops")
      .insert(stopRows)
      .select("id, stop_order, name, is_mystery");
    if (stopsErr) return jsonResponse({ error: stopsErr.message }, 400);

    const { data: adventure, error: advErr } = await admin
      .from("adventures")
      .insert({ party_id: partyId, route_id: route.id, stop_count: stopCount, mode: "real_venue" })
      .select("id, route_id, stop_count, mode")
      .single();
    if (advErr) return jsonResponse({ error: advErr.message }, 400);

    return jsonResponse({ adventure, routeId: route.id, stops });
  }

  // ---------------------------------------------------------------
  // reroll — swaps the currently-revealed, not-yet-checked-in stop's venue
  // ---------------------------------------------------------------
  if (action === "reroll") {
    const routeStopId = typeof body.routeStopId === "string" ? body.routeStopId : null;
    if (!routeStopId) return jsonResponse({ error: "routeStopId is required" }, 400);

    const { data: stop, error: stopErr } = await admin
      .from("route_stops")
      .select("id, route_id, venue_id, is_mystery, reroll_count, candidate_pool, routes!inner(owner_party_id)")
      .eq("id", routeStopId)
      .maybeSingle();
    if (stopErr || !stop) return jsonResponse({ error: "Stop not found." }, 404);

    const ownerPartyId = (stop as unknown as { routes: { owner_party_id: string | null } }).routes?.owner_party_id;
    if (!ownerPartyId || !(await isPartyMember(admin, ownerPartyId, userId))) {
      return jsonResponse({ error: "You're not a member of that party." }, 403);
    }
    if (stop.is_mystery || !stop.venue_id) {
      return jsonResponse({ error: "This stop hasn't been revealed yet." }, 400);
    }

    const { data: existingCheckIn } = await admin
      .from("check_ins")
      .select("id")
      .eq("route_stop_id", routeStopId)
      .maybeSingle();
    if (existingCheckIn) {
      return jsonResponse({ error: "You've already checked in here — can't reroll a completed stop." }, 400);
    }

    const pool = (stop.candidate_pool ?? []) as Candidate[];
    if (!pool.length) {
      return jsonResponse({ error: "No other nearby venues to roll into right now." }, 404);
    }

    const rerollCount = stop.reroll_count ?? 0;
    let spent = 0;
    if (rerollCount >= FREE_REROLLS) {
      const { data: success, error: debitErr } = await admin.rpc("debit_coins", {
        p_profile_id: userId,
        p_amount: EXTRA_ROLL_COST,
        p_reason: "extra_roll",
      });
      if (debitErr) return jsonResponse({ error: debitErr.message }, 400);
      if (!success) {
        return jsonResponse({ error: `Not enough Adventure Coins. Need ${EXTRA_ROLL_COST} for another roll.` }, 402);
      }
      spent = EXTRA_ROLL_COST;
    }

    const picked = weightedRandomPick(pool);
    const newPool = pool.filter((c) => c.id !== picked.id);

    const { data: updated, error: updateErr } = await admin
      .from("route_stops")
      .update({
        venue_id: picked.id,
        name: picked.name,
        description: [picked.category, picked.address].filter(Boolean).join(" · "),
        reroll_count: rerollCount + 1,
        candidate_pool: newPool,
      })
      .eq("id", routeStopId)
      .select("id, name, description, venue_id, reroll_count")
      .single();
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);

    return jsonResponse({
      stop: updated,
      spent,
      freeRollsRemaining: Math.max(FREE_REROLLS - (rerollCount + 1), 0),
    });
  }

  // ---------------------------------------------------------------
  // advance — reveals the next placeholder stop near the player's
  // current position, called right after a successful check-in
  // ---------------------------------------------------------------
  if (action === "advance") {
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!adventureId || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      return jsonResponse({ error: "adventureId, lat, and lng are required" }, 400);
    }

    const { data: adventure, error: advErr } = await admin
      .from("adventures")
      .select("id, party_id, route_id, mode")
      .eq("id", adventureId)
      .maybeSingle();
    if (advErr || !adventure) return jsonResponse({ error: "Adventure not found." }, 404);
    if (adventure.mode !== "real_venue") {
      return jsonResponse({ error: "This isn't a real-venue adventure." }, 400);
    }
    if (!(await isPartyMember(admin, adventure.party_id, userId))) {
      return jsonResponse({ error: "You're not a member of that party." }, 403);
    }

    const { data: allStops } = await admin
      .from("route_stops")
      .select("id, stop_order, venue_id, is_mystery")
      .eq("route_id", adventure.route_id)
      .order("stop_order", { ascending: true });
    const stops = allStops ?? [];

    const nextPlaceholder = stops.find((s) => s.is_mystery && !s.venue_id);
    if (!nextPlaceholder) {
      return jsonResponse({ done: true });
    }

    const profile = await getCallerProfile(admin, userId);
    if (!profile) return jsonResponse({ error: "Couldn't load your profile." }, 400);
    const prefs = (profile.preferences ?? {}) as Preferences;
    const radiusMiles = Math.min(prefs.radiusMiles || DEFAULT_RADIUS_MILES, profile.unlocked_radius_miles ?? DEFAULT_RADIUS_MILES);
    const categories = resolveYelpCategories(prefs);

    const alreadyVisitedVenueIds = new Set(stops.filter((s) => s.venue_id).map((s) => s.venue_id as string));

    const candidates = await searchNearbyVenues(admin, yelpKey, {
      lat, lng, radiusMiles, budget: prefs.budget, categories,
    });
    const fresh = candidates.filter((c) => !alreadyVisitedVenueIds.has(c.id));
    if (!fresh.length) {
      return jsonResponse({ error: "No new nearby venues found for the next stop — try again shortly." }, 404);
    }

    const picked = fresh[0];
    const remainingPool = fresh.slice(1);

    const { data: updated, error: updateErr } = await admin
      .from("route_stops")
      .update({
        venue_id: picked.id,
        name: picked.name,
        description: [picked.category, picked.address].filter(Boolean).join(" · "),
        is_mystery: false,
        candidate_pool: remainingPool,
      })
      .eq("id", nextPlaceholder.id)
      .select("id, stop_order, name, description, venue_id")
      .single();
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);

    return jsonResponse({ stop: updated, done: false });
  }

  return jsonResponse({ error: "action must be 'init', 'reroll', or 'advance'" }, 400);
});
