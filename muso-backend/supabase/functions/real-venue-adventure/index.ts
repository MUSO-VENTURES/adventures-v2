// POST /real-venue-adventure
// Body: { action: 'init', partyId: string, lat: number, lng: number }
//     | { action: 'reroll', routeStopId: string }
//     | { action: 'advance', adventureId: string, lat: number, lng: number }
//     | { action: 'choose', routeStopId: string, venueId: string }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Backs "fork in the road" real-venue adventures: instead of picking a
// curator-authored route, a party's stops are assembled on the fly from
// live nearby venues (matched to the player's saved profiles.preferences),
// one stop at a time — and instead of the game silently auto-picking a
// venue, each stop offers 3 real, contrasting-theme choices (cozy vs.
// adventurous vs. nightlife, etc. — see pickContrastingChoices()) for the
// player to pick from, "choose your own adventure" style. Every stop is
// represented as an ordinary routes + route_stops row (owner_party_id
// scopes it private to the creating party — see
// 0016_real_venue_adventures.sql), so the existing checkin/route-detail
// edge functions, and all the XP/badge/coin/photo-booth/progress-map UI
// built on top of them, work completely unmodified — verified by reading
// checkin/index.ts in full during planning. This function's only job is to
// create/update those rows correctly.
//
// Three-state stop lifecycle (route_stops, real-venue mode):
//   1. Unrevealed  — is_mystery=true,  venue_id=null (placeholder, nothing
//      computed yet — reuses the exact "Unknown Location" masking
//      route-detail already does for curator-authored mystery stops).
//   2. Choices offered — is_mystery=false, venue_id=null,
//      offered_choices=[3 candidates] (0019_stop_choice_offers.sql) — the
//      fork in the road. `reroll` regenerates this set; `choose` commits one.
//   3. Committed — is_mystery=false, venue_id=<chosen>, offered_choices=null
//      — identical to the old single-auto-pick "revealed" state; checkin
//      becomes available.
//
// Progressive reveal + premature-completion fix: checkin marks an adventure
// "completed" the moment check_ins count >= route_stops count for its
// route. Curated routes have every stop pre-authored, so that's correct.
// A real-venue route doesn't know stop 2's venue until the player has
// checked into stop 1 and shared their new location — so `init` instead
// pre-creates ALL of the party's target stop_count as placeholder rows up
// front, and only stop 1 gets its choices offered immediately. `advance`
// then fills in the next placeholder's offered_choices in place (UPDATE,
// not INSERT) once the player reaches it. route_stops count is therefore
// correct — equal to the target stop count — from the moment `init`
// returns, so checkin's completion math is never wrong, and the target
// stop count is automatically enforced (advance simply has nothing left to
// fill once every placeholder has been committed).
//
// Server-side trust: preferences are always re-read fresh from the caller's
// own profile row, never taken from the request body — a player can't spoof
// someone else's budget/content-rating to search a wider net than they've
// unlocked. Likewise `choose` never trusts a client-supplied venueId alone
// — it must match one of that exact stop's server-computed offered_choices.

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
// Google Places (New) search + preference-driven filtering
// (budget/interest mappings mirror venues-search/index.ts and index.html's
// INTEREST_GOOGLE_TYPES exactly, so a player sees the same kind of
// results here as they would from "Find Real Venues.")
//
// Migrated off the Yelp Fusion API (Yelp's free trial expired and the
// $229/mo plan wasn't viable) — see git history for the prior Yelp-backed
// version of this file if anything here needs comparing against it. The
// internal `Candidate`/hours shapes are kept byte-compatible with the old
// Yelp-derived shape on purpose (see VenueHours below and
// googleHoursToVenueHours()) so isOpenOrClosingSoon() here, ITS BYTE-FOR-
// BYTE DUPLICATE IN preview/index.html, and every downstream consumer of
// the `venues` table (route-detail, checkin, admin dashboard, all
// frontend rendering) needed zero changes — only this file's own
// Places-calling code and the DB upsert/lookup RPCs changed provider.
// ---------------------------------------------------------------

const DEFAULT_RADIUS_MILES = 15;
const PLACES_MAX_RADIUS_METERS = 50000; // Google Places (New) Nearby Search hard cap
const FREE_REROLLS = 3;
const EXTRA_ROLL_COST = 20;
// Quality floor on Google's own rating — only 4.0+ star venues are ever
// offered as a fork choice. Applied as a hard filter (not just a
// weightedRandomPick weighting bump) on searchNearbyVenues()'s return
// value, so every code path (init/advance/reroll) is covered from one
// place. A venue with no rating at all is excluded too — no rating means
// no way to confirm it clears the bar.
const MIN_VENUE_RATING = 4.0;

// Google Places (New) priceLevels enum — request-side filter equivalent to
// Yelp's old 1-4 price param. Never actually persisted to the venues table
// either way (see the Yelp-era comment history), only used to narrow the
// search itself.
const VALID_BUDGETS: Record<string, string[]> = {
  "$": ["PRICE_LEVEL_INEXPENSIVE"],
  "$$": ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE"],
  "$$$": ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE"],
  "$$$$": ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"],
};

// Google Places (New) "Table A" type strings — verified against Google's
// current place-types docs. A few Yelp categories have no exact Google
// equivalent (climbing gyms, escape rooms, antique stores specifically,
// kayaking/outdoor-gear shops); those fall back to the nearest real type
// noted inline below rather than being silently dropped.
const INTEREST_GOOGLE_TYPES: Record<string, string[]> = {
  "Food & Drink": ["restaurant", "bar"],
  "Outdoors": ["park", "hiking_area"],
  "Arts & Culture": ["art_gallery", "museum", "performing_arts_theater"],
  "Games & Competition": ["video_arcade", "bowling_alley", "amusement_center" /* escape rooms — no dedicated type */, "adventure_sports_center" /* go-karts/axe throwing — no dedicated type */],
  "Live Music": ["live_music_venue", "concert_hall"],
  "Wellness": ["spa", "yoga_studio"],
  "Nightlife": ["night_club", "cocktail_bar"],
  "Shopping": ["shopping_mall"],
  "Pet-Friendly": ["dog_park", "pet_store", "zoo", "aquarium"],
  "Comedy": ["comedy_club"],
  "Cultured": ["opera_house", "performing_arts_theater", "art_museum", "art_gallery"],
  "Oddities & Curiosities": ["museum"],
  "Smoke & Cigar": ["hookah_bar" /* cigar/vape/tobacco shops — no dedicated type */],
};

// Best-effort only — Google has no maturity/content field, so this just
// steers a family-safe profile away from bar-centric categories. Not a
// substitute for the client-side age gate, which is the real enforcement.
const NOT_FAMILY_SAFE_TYPES = new Set([
  "bar", "night_club", "cocktail_bar", "hookah_bar", "pub", "wine_bar",
]);

type Preferences = {
  budget?: string;
  radiusMiles?: number;
  contentRating?: string;
  alcohol?: string;
  interests?: string[];
};

function resolveGoogleTypes(prefs: Preferences): string[] {
  const interests = prefs.interests ?? [];
  let types = [...new Set(
    interests.flatMap((v) => INTEREST_GOOGLE_TYPES[v] ?? []),
  )];
  const familySafe = prefs.alcohol === "Sober / Alcohol-Free"
    || prefs.contentRating === "G-Rated"
    || prefs.contentRating === "PG-Rated";
  if (familySafe) {
    types = types.filter((t) => !NOT_FAMILY_SAFE_TYPES.has(t));
  }
  return types;
}

function milesToMeters(miles: number): number {
  return Math.round(miles * 1609.34);
}

// Kept in this exact Yelp-derived shape deliberately — see the file-header
// comment above. Populated now from Google's regularOpeningHours via
// googleHoursToVenueHours() instead of a live Yelp Business Details call.
type VenueHours = { hour_type: string; is_open_now: boolean; open: { day: number; start: string; end: string; is_overnight: boolean }[] }[];

// Google's OpeningHours.periods[].open/close shape (the subset of fields
// this file actually reads) — see googleHoursToVenueHours() below.
type GooglePoint = { day: number; hour: number; minute: number };
type GoogleOpeningHours = { openNow?: boolean; periods?: { open: GooglePoint; close?: GooglePoint }[] } | null | undefined;

// Google: day 0=Sunday..6=Saturday, hour/minute as separate ints. Yelp
// (the shape everything downstream still expects): day 0=Monday..6=Sunday,
// start/end as "HHMM" strings, is_overnight as an explicit per-block flag.
// Converts once here, at the provider boundary, so isOpenOrClosingSoon()
// below (and its byte-for-byte duplicate in preview/index.html) never need
// to know Google's shape exists.
function googleHoursToVenueHours(hours: GoogleOpeningHours): VenueHours | null {
  if (!hours || !Array.isArray(hours.periods)) return null;
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const toInternalDay = (googleDay: number) => (googleDay + 6) % 7; // Google 0=Sunday -> internal 0=Monday
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
  muso_rating: number | null;
  muso_rating_count: number | null;
  google_place_id: string | null;
  hours: VenueHours | null;
  hours_fetched_at: string | null;
};

// Runs a live Google Places Nearby Search (New), upserts results into
// `venues` (via the upsert_places_venues RPC, same pattern venues-search
// uses), then asks nearby_candidate_venues() for the distance-sorted,
// DB-merged (real partner_tier) result set. Returns [] (never throws) on
// any Places-side failure — a network hiccup shouldn't crash init/advance,
// it should just come back with "no venues found."
//
// Requests rating, userRatingCount, and regularOpeningHours in the same
// call as photos/address/location — all four already put the call at
// Google's "Enterprise" pricing tier (rating alone does), so there's no
// cost benefit to a separate Place Details call for hours the way Yelp
// required (its Search endpoint never returned hours at all, only Business
// Details did) — see the now-removed getVenueHours() in git history.
// hours are written straight into `venues.hours`/`hours_fetched_at` below,
// same columns the old 24h Yelp-hours cache used, just populated
// write-through on every search instead of lazily per offered candidate.
async function searchNearbyVenues(
  admin: Admin,
  placesServerKey: string,
  placesPhotoKey: string,
  opts: { lat: number; lng: number; radiusMiles: number; budget?: string; categories: string[] },
): Promise<Candidate[]> {
  const radiusMeters = Math.min(milesToMeters(opts.radiusMiles), PLACES_MAX_RADIUS_METERS);
  const priceLevels = opts.budget && VALID_BUDGETS[opts.budget] ? VALID_BUDGETS[opts.budget] : undefined;

  const requestBody: Record<string, unknown> = {
    locationRestriction: { circle: { center: { latitude: opts.lat, longitude: opts.lng }, radius: radiusMeters } },
    maxResultCount: 20,
    rankPreference: "DISTANCE",
  };
  if (opts.categories.length) requestBody.includedTypes = opts.categories;
  if (priceLevels) requestBody.priceLevels = priceLevels;

  let places: Record<string, unknown>[];
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
          "places.googleMapsUri",
        ].join(","),
      },
      body: JSON.stringify(requestBody),
    });
    if (!placesRes.ok) {
      // Was silently returning [] here — indistinguishable from a genuinely
      // empty search, so a Places-side failure (rate limit, bad/expired
      // key, billing not enabled, etc.) showed players the exact same "No
      // matching venues found nearby" message as an actual empty result.
      // Logged so the real cause is visible in this function's Supabase
      // dashboard logs.
      const errBody = await placesRes.text().catch(() => "");
      console.error(`Google Places search failed: ${placesRes.status} ${placesRes.statusText} — ${errBody.slice(0, 500)}`);
      return [];
    }
    const placesData = await placesRes.json();
    places = Array.isArray(placesData.places) ? placesData.places : [];
    if (!places.length) {
      console.log(`Google Places search returned 0 places: lat=${opts.lat} lng=${opts.lng} radiusMeters=${radiusMeters} types=${opts.categories.join(",") || "(none)"} priceLevels=${priceLevels?.join(",") ?? "(any)"}`);
    }
  } catch (e) {
    console.error("Google Places search threw:", e);
    return [];
  }

  const rows = places.map((p) => {
    const location = (p.location ?? {}) as Record<string, unknown>;
    const photos = Array.isArray(p.photos) ? p.photos as Record<string, unknown>[] : [];
    const photoName = photos[0]?.name as string | undefined;
    // Ready-to-use, no-extra-call image URL — the Photo Media endpoint
    // redirects straight to the actual image when hit, same "just embed
    // this URL" ergonomics Yelp's image_url had. Uses the referrer-
    // restricted photo key (not the server key) since this URL is shown
    // directly in players' browsers.
    const imageUrl = photoName
      ? `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=800&key=${placesPhotoKey}`
      : null;
    // Google's type strings are snake_case ("wine_bar"); the theme-bucket
    // keyword lists below were written against Yelp's space-separated
    // category titles ("Wine Bar", "ice cream" etc.) — swapping
    // underscores for spaces keeps classifyTheme()'s substring keyword
    // matching working the same way against either provider's text.
    const primaryType = p.primaryType as string | undefined;
    const category = primaryType ? primaryType.replace(/_/g, " ") : null;
    return {
      google_place_id: p.id as string,
      name: (p.displayName as Record<string, unknown> | undefined)?.text as string | undefined,
      category,
      address: (p.formattedAddress as string) || null,
      lat: (location.latitude as number | undefined) ?? null,
      lng: (location.longitude as number | undefined) ?? null,
      phone: (p.nationalPhoneNumber as string) || null,
      rating: (p.rating as number) ?? null,
      rating_count: (p.userRatingCount as number) ?? null,
      source_url: (p.googleMapsUri as string) || null,
      image_url: imageUrl,
      hours: googleHoursToVenueHours(p.regularOpeningHours as GoogleOpeningHours),
    };
  }).filter((r) => r.google_place_id && r.name && r.lat != null && r.lng != null);

  if (!rows.length) {
    console.log(`Google Places returned ${places.length} places but 0 survived the id/name/lat/lng filter`);
    return [];
  }

  try {
    // rows is passed as a plain array, NOT JSON.stringify(rows) — the SQL
    // function's `rows jsonb` parameter expects a genuine JSONB array.
    // Stringifying it here double-encodes it: PostgREST hands Postgres a
    // JSON *string* whose contents happen to look like an array, which
    // Postgres casts to a JSONB scalar (a string), not a JSONB array — so
    // jsonb_array_elements(rows) inside the function fails on every call
    // with "cannot extract elements from a scalar", silently caught below
    // and surfacing to players as "No matching venues found nearby."
    const { error: upsertErr } = await admin.rpc("upsert_places_venues", { rows });
    if (upsertErr) {
      console.error("upsert_places_venues RPC error:", JSON.stringify(upsertErr));
      return [];
    }
  } catch (e) {
    console.error("upsert_places_venues threw:", e);
    return [];
  }

  const { data: candidates, error: nearbyErr } = await admin.rpc("nearby_candidate_venues", {
    p_lat: opts.lat,
    p_lng: opts.lng,
    p_radius_miles: opts.radiusMiles,
    p_google_place_ids: rows.map((r) => r.google_place_id),
  });
  if (nearbyErr) {
    console.error("nearby_candidate_venues RPC error:", JSON.stringify(nearbyErr));
    return [];
  }
  if (!candidates?.length) {
    console.log(`nearby_candidate_venues returned 0 rows for ${rows.length} upserted place_ids, radius=${opts.radiusMiles}mi, lat=${opts.lat}, lng=${opts.lng}`);
  }

  const allCandidates = (candidates ?? []) as Candidate[];
  // "Preferably good photos, but not limited to good photos" — there's no
  // reliable signal for photo *quality* from the Places response (just one
  // representative photo reference), so the bar is "has a real photo at
  // all," not an aesthetic judgment call.
  const withPhotoAndRating = allCandidates.filter(
    (c) => c.rating != null && c.rating >= MIN_VENUE_RATING && !!c.image_url,
  );
  if (withPhotoAndRating.length < allCandidates.length) {
    console.log(`Filtered out ${allCandidates.length - withPhotoAndRating.length} of ${allCandidates.length} candidates (below ${MIN_VENUE_RATING} stars or missing a photo)`);
  }

  return withPhotoAndRating;
}

// The within-theme pick used by pickContrastingChoices() below — "a random
// highly rated venue" from a given bucket, not a deterministic
// always-take-the-#1 pick. Weight favors featured (premium/sponsor)
// partner_tier 3x, multiplied by the venue's own Yelp rating (0-5 stars,
// defaulting unrated venues to a neutral 3 so they're deprioritized but
// never literally unreachable), multiplied by a proximity factor so the
// route feels like one organic loop instead of bouncing around the full
// search radius — distance_miles is always measured from wherever the
// player currently is (each advance() call re-anchors on their live
// position), so favoring nearby candidates here keeps each next stop
// close to the one they just left. This is a soft bias, not a hard cutoff
// — a great, more-distant venue can still win, especially in a sparse
// theme bucket where it's the only option.
function proximityWeight(distanceMiles: number): number {
  return 1 / (1 + distanceMiles / 5); // ~50% weight at 5mi, ~25% at 15mi, ~14% at 30mi
}

function weightedRandomPick(candidates: Candidate[]): Candidate {
  const isFeatured = (c: Candidate) => c.partner_tier === "premium" || c.partner_tier === "sponsor";
  const weights = candidates.map((c) => (isFeatured(c) ? 3 : 1) * (c.rating ?? 3) * proximityWeight(c.distance_miles ?? 0));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

// ---------------------------------------------------------------
// Fork-in-the-road: contrasting theme buckets for the 3-choice reveal.
// Best-effort keyword match against Yelp's category string AND the
// venue's own name — same "good enough, not perfect" spirit as the
// family-safe filtering above. Matching the name too matters most for the
// wine buckets below: Yelp's category taxonomy only has "Wineries"/"Wine
// Bars," nothing distinguishing boutique vs. estate vs. tasting-room, so
// that signal can only come from words in the business's own name.
// ---------------------------------------------------------------

type Theme = { key: string; label: string; emoji: string; color: string };

const THEME_BUCKETS: (Theme & { keywords: string[] })[] = [
  {
    key: "cozy", label: "Cozy & Chill", emoji: "🍷", color: "#5b4b8a",
    keywords: ["wine", "lounge", "cafe", "coffee", "tea room", "tea house", "bookstore", "spa", "bed & breakfast"],
  },
  {
    key: "adventurous", label: "Bold & Active", emoji: "🎯", color: "#e8503f",
    keywords: [
      "axe", "escape", "arcade", "bowling", "mini golf", "minigolf", "go kart", "gokart",
      "climbing", "hiking", "park", "adventure", "laser tag", "trampoline", "paintball",
      "skating", "batting cage", "amusement", "zip line", "surf", "kayak", "ropes course",
    ],
  },
  {
    key: "social", label: "Social & Lively", emoji: "🎤", color: "#0b6e68",
    keywords: [
      "karaoke", "bar", "nightlife", "club", "pub", "brewery", "brewpub", "cocktail",
      "beer", "distillery", "dive bar", "sports bar", "speakeasy", "dance",
    ],
  },
  {
    key: "artsy", label: "Artsy & Unique", emoji: "🎨", color: "#f2994a",
    keywords: [
      "museum", "gallery", "theater", "theatre", "art", "music", "comedy", "cinema",
      "movie", "planetarium", "aquarium", "zoo", "botanical", "pottery", "studio",
    ],
  },
  {
    key: "foodie", label: "Foodie Find", emoji: "🍜", color: "#0ea5a0",
    keywords: [
      "restaurant", "food", "noodle", "pizza", "bbq", "barbecue", "dessert", "bakery",
      "diner", "breakfast", "brunch", "sandwich", "deli", "burger", "taco", "mexican",
      "italian", "chinese", "japanese", "sushi", "thai", "indian", "vietnamese", "korean",
      "mediterranean", "greek", "american", "steakhouse", "seafood", "vegan", "vegetarian",
      "buffet", "grill", "kitchen", "eatery", "bistro", "tapas", "ramen", "dim sum",
      "chicken", "salad", "creamery", "ice cream", "donut", "cupcake", "juice", "smoothie",
    ],
  },
];
const GENERAL_THEME: Theme = { key: "local", label: "Local Pick", emoji: "📍", color: "#2a2438" };

// Wine Country Adventure — every candidate is a winery/tasting room OR one
// of the companion categories below, so the general mood buckets above
// (cozy/adventurous/social/artsy/foodie) would barely differentiate
// anything. This parallel bucket set classifies by the *kind* of wine-
// country stop instead, matched against Yelp's category/name text.
const WINE_GOOGLE_TYPES = ["winery", "wine_bar", "vineyard"];
// Most wineries don't open until mid-morning/early-afternoon — searching
// wineries only meant an early-day player got "no venues found" with
// nothing to do until they opened. These ride along in the same search so
// pickOpenChoices()'s existing hours filter (built for the general hours-
// gating feature) naturally prefers whichever part of the pool is
// actually open right now: coffee/food/entertainment/sightseeing early,
// shifting to real wineries as the day goes on and they open — no
// separate time-of-day logic needed, just a wider net for the same filter.
const WINE_COMPANION_TYPES = [
  "coffee_shop", "brunch_restaurant", "diner", "bakery", "tourist_attraction", "park",
];
const WINE_THEME_BUCKETS: (Theme & { keywords: string[] })[] = [
  {
    key: "boutique", label: "Boutique Winery", emoji: "🍇", color: "#7a3b69",
    keywords: ["boutique", "family owned", "small batch", "artisan"],
  },
  {
    key: "estate", label: "Estate & Vineyard", emoji: "🏛️", color: "#5b4b8a",
    keywords: ["estate", "vineyard", "chateau", "château", "villa", "ranch"],
  },
  {
    key: "tasting_bar", label: "Tasting Room Bar", emoji: "🥂", color: "#0b6e68",
    keywords: ["wine bar", "tasting room", "wine lounge", "cellar", "wine cellar"],
  },
  // Four distinct companion buckets, not one lumped-together "coffee or
  // whatever" bucket — split so pickContrastingChoices() actually has
  // enough distinct themes to draw 3 different picks from instead of
  // repeating the same one twice (which is what a single catch-all bucket
  // produced in practice — two "Morning Fuel" cards and one "Winery").
  {
    key: "morning_fuel", label: "Morning Fuel", emoji: "☕", color: "#8a5b3b",
    keywords: ["coffee", "cafe", "bakery", "pastry", "donut"],
  },
  {
    key: "food", label: "Food", emoji: "🍽️", color: "#c9622f",
    keywords: ["breakfast", "brunch", "diner", "sandwich", "deli"],
  },
  {
    key: "entertainment", label: "Entertainment", emoji: "🚲", color: "#2f8f5b",
    keywords: ["bike", "cycle", "rental", "tour"],
  },
  {
    key: "sightseeing", label: "Sightseeing", emoji: "🗺️", color: "#1d6fa3",
    keywords: ["landmark", "historic", "monument", "scenic", "viewpoint", "overlook", "park", "garden"],
  },
];
const WINE_GENERAL_THEME: Theme = { key: "winery", label: "Winery", emoji: "🍷", color: "#2a2438" };
const WINE_NEARBY_FALLBACK: Theme = { key: "nearby", label: "Local Gem", emoji: "💎", color: "#5b5b5b" };
// Whenever an actual winery makes it into the offered choices, it should
// always be card 1, not wherever pickContrastingChoices()'s randomized
// bucket order happened to land it — this is the "Wine Country" adventure,
// after all. Used by pickOpenChoices() below to reorder its final result;
// the companion buckets (morning_fuel/food/entertainment/sightseeing)
// still fill the early-day gap before any winery is open, they just never
// outrank one once it is.
const WINERY_THEME_KEYS = new Set(["boutique", "estate", "tasting_bar", "winery"]);

// ---------------------------------------------------------------
// Themed real-venue adventures beyond Wine Country. Same shape/mechanic as
// Wine Country above (locked search categories + its own bucket set), no
// changes needed to the choose/commit/checkin state machine at all — that
// logic only ever cares that a stop has 3 offered_choices, never which
// theme produced them. THEME_SET_META (below classifyTheme) is what wires
// each bucket set's own fallback theme in without special-casing.
// ---------------------------------------------------------------

const DOG_GOOGLE_TYPES = ["dog_park", "pet_store", "park", "brewery", "brewpub", "hiking_area"];
const DOG_THEME_BUCKETS: (Theme & { keywords: string[] })[] = [
  {
    key: "dog_park", label: "Dog Park", emoji: "🐕", color: "#4a8f3c",
    keywords: ["dog park", "off-leash", "off leash", "dog run", "bark park"],
  },
  {
    key: "pet_shop", label: "Pet Boutique", emoji: "🦴", color: "#c9622f",
    keywords: ["pet store", "pet shop", "pet boutique", "pet supply", "grooming", "pet groomer"],
  },
  {
    key: "patio_hang", label: "Pup-Friendly Patio", emoji: "🍺", color: "#8a5b3b",
    keywords: ["brewery", "beer garden", "biergarten", "patio", "taproom", "beer hall"],
  },
  {
    key: "trail", label: "Trail Walk", emoji: "🥾", color: "#2f8f5b",
    keywords: ["trail", "hike", "hiking", "preserve", "open space", "greenbelt"],
  },
];
const DOG_GENERAL_THEME: Theme = { key: "dog_spot", label: "Dog-Friendly Spot", emoji: "🐾", color: "#4a8f3c" };

// climbing/kayaking-outdoor-gear have no dedicated Google type — substituted
// with the nearest real matches (sports_activity_location, sporting_goods_store).
const OUTDOOR_GOOGLE_TYPES = ["hiking_area", "park", "sports_activity_location", "sporting_goods_store", "campground"];
const OUTDOOR_THEME_BUCKETS: (Theme & { keywords: string[] })[] = [
  {
    key: "trailhead", label: "Trailhead", emoji: "🥾", color: "#2f8f5b",
    keywords: ["trail", "hike", "hiking", "summit", "overlook", "ridge"],
  },
  {
    key: "water", label: "On the Water", emoji: "🛶", color: "#1d6fa3",
    keywords: ["kayak", "paddle", "lake", "river", "canoe", "boat launch"],
  },
  {
    key: "climb", label: "Climb & Explore", emoji: "🧗", color: "#8a5b3b",
    keywords: ["climbing", "rock", "boulder", "zipline", "zip line", "ropes course"],
  },
  {
    key: "scenic", label: "Scenic Stop", emoji: "🌄", color: "#c9622f",
    keywords: ["park", "preserve", "viewpoint", "scenic", "garden", "reserve", "campground"],
  },
];
const OUTDOOR_GENERAL_THEME: Theme = { key: "outdoor_spot", label: "Outdoor Pick", emoji: "🏞️", color: "#2f8f5b" };

// escape rooms/antique stores have no dedicated Google type — substituted
// with the nearest real matches (amusement_center, thrift_store).
const ODDITIES_GOOGLE_TYPES = ["museum", "thrift_store", "video_arcade", "amusement_center", "gift_shop"];
const ODDITIES_THEME_BUCKETS: (Theme & { keywords: string[] })[] = [
  {
    key: "curiosity_shop", label: "Curiosity Shop", emoji: "🔮", color: "#5b3b8a",
    keywords: ["oddities", "curiosities", "curio", "occult", "metaphysical", "witch"],
  },
  {
    key: "weird_museum", label: "Weird Museum", emoji: "🦴", color: "#7a3b69",
    keywords: ["museum", "taxidermy", "oddity", "wax museum", "curiosities"],
  },
  {
    key: "vintage_find", label: "Vintage Find", emoji: "🕰️", color: "#8a5b3b",
    keywords: ["antique", "vintage", "thrift", "flea market", "retro"],
  },
  {
    key: "strange_fun", label: "Strange & Fun", emoji: "👾", color: "#0b6e68",
    keywords: ["arcade", "escape room", "haunted", "novelty", "game"],
  },
];
const ODDITIES_GENERAL_THEME: Theme = { key: "odd_spot", label: "Odd Find", emoji: "🔮", color: "#5b3b8a" };

const FOODIE_GOOGLE_TYPES = ["restaurant", "bakery", "dessert_shop", "ice_cream_shop"];
const FOODIE_THEME_BUCKETS: (Theme & { keywords: string[] })[] = [
  {
    key: "street_eats", label: "Street Eats", emoji: "🌮", color: "#c9622f",
    keywords: ["food truck", "taco", "street food", "food cart"],
  },
  {
    key: "sit_down", label: "Sit-Down Spot", emoji: "🍽️", color: "#8a3b3b",
    keywords: ["restaurant", "bistro", "steakhouse", "fine dining", "kitchen", "grill"],
  },
  {
    key: "sweet_tooth", label: "Sweet Tooth", emoji: "🍰", color: "#c9628f",
    keywords: ["dessert", "bakery", "ice cream", "donut", "cupcake", "creamery"],
  },
  {
    key: "world_flavors", label: "World Flavors", emoji: "🍜", color: "#0ea5a0",
    keywords: ["sushi", "thai", "mexican", "italian", "indian", "chinese", "vietnamese", "korean", "mediterranean"],
  },
];
const FOODIE_GENERAL_THEME: Theme = { key: "food_spot", label: "Tasty Find", emoji: "🍽️", color: "#c9622f" };

const AFTER_HOURS_GOOGLE_TYPES = ["bar", "cocktail_bar", "night_club", "live_music_venue", "pub", "wine_bar"];
const AFTER_HOURS_THEME_BUCKETS: (Theme & { keywords: string[] })[] = [
  {
    key: "craft_cocktails", label: "Craft Cocktails", emoji: "🍸", color: "#5b4b8a",
    keywords: ["cocktail", "mixology", "speakeasy", "craft bar", "martini"],
  },
  {
    key: "live_music", label: "Live Music", emoji: "🎶", color: "#8a3b5b",
    keywords: ["live music", "music venue", "concert", "band", "jazz", "karaoke"],
  },
  {
    key: "late_night_bites", label: "Late-Night Bites", emoji: "🌮", color: "#c9622f",
    keywords: ["late night", "24 hour", "diner", "food truck", "pizza"],
  },
  {
    key: "chill_lounge", label: "Chill Lounge", emoji: "🛋️", color: "#0b6e68",
    keywords: ["lounge", "wine bar", "rooftop", "hookah", "beer garden"],
  },
];
const AFTER_HOURS_GENERAL_THEME: Theme = { key: "night_spot", label: "Night Out Pick", emoji: "🌙", color: "#2a3a63" };

// A sparse market can genuinely only have 2 distinct themes worth of open,
// rated candidates — in that case pickContrastingChoices()'s last-resort
// backfill has to repeat one, which used to mean two cards showing the
// exact same label AND emoji ("Nearby Pick" 📍 twice). Rather than that
// read as broken/boring, diversifyLabels() below swaps in a different
// label+emoji pairing from the same theme's pool for each repeat — same
// underlying theme.key (still used for chosen_theme_key/analytics) and
// same accent color (still visibly "the same family"), just a different
// name and icon, so all 3 cards always look distinct even when the real
// category variety isn't there.
const THEME_VARIANT_ALTERNATES: Record<string, { label: string; emoji: string }[]> = {
  nearby: [
    { label: "Hidden Find", emoji: "🔍" },
    { label: "Off the Beaten Path", emoji: "🧭" },
    { label: "Worth the Detour", emoji: "⭐" },
    { label: "Local Favorite", emoji: "❤️" },
    { label: "Curious Stop", emoji: "❓" },
  ],
  winery: [
    { label: "Wine Stop", emoji: "🍾" },
    { label: "Pour & Explore", emoji: "🍇" },
    { label: "Vino Find", emoji: "🥂" },
    { label: "Tasting Spot", emoji: "🍇" },
  ],
  morning_fuel: [
    { label: "Morning Bite", emoji: "🥯" },
    { label: "Caffeine Stop", emoji: "🧋" },
    { label: "Sweet Start", emoji: "🥐" },
  ],
  food: [
    { label: "Bite to Eat", emoji: "🥪" },
    { label: "Local Eats", emoji: "🍴" },
    { label: "Quick Bite", emoji: "🍕" },
  ],
  entertainment: [
    { label: "Fun Stop", emoji: "🎯" },
    { label: "Get Moving", emoji: "🚴" },
  ],
  sightseeing: [
    { label: "Scenic Stop", emoji: "🌄" },
    { label: "Photo Op", emoji: "📸" },
  ],
};

function diversifyLabels<T extends { theme: Theme }>(chosen: T[]): T[] {
  const usedVariants = new Set<string>(); // "label|emoji" pairs already on screen
  const nextAltIndex: Record<string, number> = {};
  return chosen.map((c) => {
    let { label, emoji } = c.theme;
    if (usedVariants.has(`${label}|${emoji}`)) {
      const pool = THEME_VARIANT_ALTERNATES[c.theme.key] ?? [];
      let idx = nextAltIndex[c.theme.key] ?? 0;
      while (idx < pool.length && usedVariants.has(`${pool[idx].label}|${pool[idx].emoji}`)) idx++;
      if (idx < pool.length) {
        label = pool[idx].label;
        emoji = pool[idx].emoji;
        nextAltIndex[c.theme.key] = idx + 1;
      }
    }
    usedVariants.add(`${label}|${emoji}`);
    return { ...c, theme: { ...c.theme, label, emoji } };
  });
}

// Per-bucket-set fallback behavior, keyed by the bucket array's own object
// identity (the same "which set is this" trick classifyTheme/pickOpenChoices
// used to do with a hardcoded `buckets !== WINE_THEME_BUCKETS` check) — this
// is what lets classifyTheme/pickOpenChoices below stay bucket-set-agnostic
// while Wine Country keeps its bespoke regex fallback and winery-first sort,
// and each newer theme set gets a plain single fallback theme with no sort
// bias. Populated once, right after every bucket-set const above exists.
type ThemeSetMeta = {
  fallbackRegex?: RegExp;
  fallbackMatchTheme?: Theme;
  fallbackNoMatchTheme?: Theme;
  generalTheme?: Theme;
  primaryKeys?: Set<string>;
};
const THEME_SET_META = new Map<(Theme & { keywords: string[] })[], ThemeSetMeta>([
  [
    WINE_THEME_BUCKETS,
    {
      // `category` is Yelp's own first-listed category for a business, which
      // often isn't the same category our search actually matched it on — a
      // diner or park found via the companion-category search can easily not
      // contain any of the food/entertainment/sightseeing keywords above, and
      // was previously mislabeled "Winery" by a single shared fallback (the
      // only fallback that existed). Only call it a winery if its own
      // category/name text actually says so; anything else companion-shaped
      // gets its own honest "nearby pick" label instead.
      fallbackRegex: /winery|winer(y|ies)|vineyard|wine/,
      fallbackMatchTheme: WINE_GENERAL_THEME,
      fallbackNoMatchTheme: WINE_NEARBY_FALLBACK,
      primaryKeys: WINERY_THEME_KEYS,
    },
  ],
  [DOG_THEME_BUCKETS, { generalTheme: DOG_GENERAL_THEME }],
  [OUTDOOR_THEME_BUCKETS, { generalTheme: OUTDOOR_GENERAL_THEME }],
  [ODDITIES_THEME_BUCKETS, { generalTheme: ODDITIES_GENERAL_THEME }],
  [FOODIE_THEME_BUCKETS, { generalTheme: FOODIE_GENERAL_THEME }],
  [AFTER_HOURS_THEME_BUCKETS, { generalTheme: AFTER_HOURS_GENERAL_THEME }],
]);

// Keyed by routes.venue_theme — the single source of truth for every
// locked themed adventure (init/reroll/advance below all look a route's
// venueTheme up here instead of a per-theme boolean). Adding a new themed
// adventure is just adding an entry here (plus a bucket set + Google
// types above and a picker CTA card in preview/index.html) — nothing in
// the choose/commit/checkin state machine needs to know it exists.
type ThemeRegistryEntry = {
  buckets: (Theme & { keywords: string[] })[];
  googleTypes: string[];
  title: string;
  description: string;
};
const THEME_REGISTRY: Record<string, ThemeRegistryEntry> = {
  wine_country: {
    buckets: WINE_THEME_BUCKETS,
    googleTypes: [...WINE_GOOGLE_TYPES, ...WINE_COMPANION_TYPES],
    title: "Wine Country Adventure",
    description: "A fork in the road at every stop. Pick your path through real, live nearby wineries and tasting rooms.",
  },
  dog_friendly: {
    buckets: DOG_THEME_BUCKETS,
    googleTypes: DOG_GOOGLE_TYPES,
    title: "Dog Friendly Adventure",
    description: "A fork in the road at every stop. Pick your path through real, live nearby dog-friendly spots.",
  },
  outdoor: {
    buckets: OUTDOOR_THEME_BUCKETS,
    googleTypes: OUTDOOR_GOOGLE_TYPES,
    title: "Outdoor Adventure",
    description: "A fork in the road at every stop. Pick your path through real, live nearby trails and outdoor spots.",
  },
  oddities: {
    buckets: ODDITIES_THEME_BUCKETS,
    googleTypes: ODDITIES_GOOGLE_TYPES,
    title: "Oddities Adventure",
    description: "A fork in the road at every stop. Pick your path through real, live nearby curiosities and oddities.",
  },
  foodie_tour: {
    buckets: FOODIE_THEME_BUCKETS,
    googleTypes: FOODIE_GOOGLE_TYPES,
    title: "Foodies Adventure",
    description: "A fork in the road at every stop. Pick your path through real, live nearby food spots.",
  },
  after_hours: {
    buckets: AFTER_HOURS_THEME_BUCKETS,
    googleTypes: AFTER_HOURS_GOOGLE_TYPES,
    title: "After Hours Adventure",
    description: "A fork in the road at every stop. Pick your path through real, live nearby bars, lounges, and late-night spots.",
  },
};

function classifyTheme(candidate: Candidate, buckets: (Theme & { keywords: string[] })[] = THEME_BUCKETS): Theme {
  const cat = `${candidate.category ?? ""} ${candidate.name ?? ""}`.toLowerCase();
  for (const bucket of buckets) {
    if (bucket.keywords.some((kw) => cat.includes(kw))) {
      const { keywords: _keywords, ...theme } = bucket;
      return theme;
    }
  }
  const meta = THEME_SET_META.get(buckets);
  if (!meta) return GENERAL_THEME;
  if (meta.fallbackRegex) return meta.fallbackRegex.test(cat) ? meta.fallbackMatchTheme! : meta.fallbackNoMatchTheme!;
  return meta.generalTheme ?? GENERAL_THEME;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Picks up to n candidates from DISTINCT contrasting themes — "cozy vs.
// adventurous vs. nightlife," not three similar wine bars — weighted
// toward higher-rated/featured venues within each theme via
// weightedRandomPick. Backfills from the general remaining pool if fewer
// than n themes have any matching candidates (e.g. a sparse market).
function pickContrastingChoices(
  candidates: Candidate[],
  n: number,
  buckets: (Theme & { keywords: string[] })[] = THEME_BUCKETS,
): (Candidate & { theme: Theme })[] {
  const byTheme = new Map<string, { theme: Theme; items: Candidate[] }>();
  for (const c of candidates) {
    const theme = classifyTheme(c, buckets);
    if (!byTheme.has(theme.key)) byTheme.set(theme.key, { theme, items: [] });
    byTheme.get(theme.key)!.items.push(c);
  }
  const chosen: (Candidate & { theme: Theme })[] = [];
  const usedIds = new Set<string>();
  const usedThemeKeys = new Set<string>();

  for (const { theme, items } of shuffle([...byTheme.values()])) {
    if (chosen.length >= n) break;
    const pick = weightedRandomPick(items);
    chosen.push({ ...pick, theme });
    usedIds.add(pick.id);
    usedThemeKeys.add(theme.key);
  }

  // Backfill only from themes not already represented first — the old
  // version backfilled from ANY remaining candidate regardless of theme,
  // so a market with only 1 "cozy" spot but 5 "foodie" ones could end up
  // offering the same theme twice. A repeated theme is now only allowed as
  // an absolute last resort, when fewer than n distinct themes exist among
  // ALL nearby candidates.
  if (chosen.length < n) {
    const remaining = candidates.filter((c) => !usedIds.has(c.id) && !usedThemeKeys.has(classifyTheme(c, buckets).key));
    while (chosen.length < n && remaining.length) {
      const pick = weightedRandomPick(remaining);
      const theme = classifyTheme(pick, buckets);
      chosen.push({ ...pick, theme });
      usedIds.add(pick.id);
      usedThemeKeys.add(theme.key);
      remaining.splice(remaining.findIndex((c) => c.id === pick.id), 1);
    }
  }

  if (chosen.length < n) {
    const remaining = candidates.filter((c) => !usedIds.has(c.id));
    while (chosen.length < n && remaining.length) {
      const pick = weightedRandomPick(remaining);
      chosen.push({ ...pick, theme: classifyTheme(pick, buckets) });
      usedIds.add(pick.id);
      remaining.splice(remaining.findIndex((c) => c.id === pick.id), 1);
    }
  }

  return chosen;
}

// ---------------------------------------------------------------
// Venue hours — "never offer a closed or closing-soon venue."
// ---------------------------------------------------------------

const CLOSING_SOON_BUFFER_MINUTES = 30;
// Every current/planned venue (Tri-Valley, Napa, Mendocino, Lake County) is
// in Pacific time — hardcoded rather than adding a timezone-lookup
// dependency for a case that doesn't exist yet. Revisit if this ever
// expands outside California.
const VENUE_TIMEZONE = "America/Los_Angeles";

// "Morning Fuel"/"Morning Bite" etc. shouldn't still say "Morning" at 4pm
// — this swaps the leading time-of-day word for whichever one is
// currently correct, in the same Pacific time zone/source used for the
// open-hours check above. Applied as a label rewrite (applyTimeOfDayLabels
// below) rather than baked into the bucket/alternate definitions, so
// there's exactly one place that knows what "morning" means.
function currentTimeOfDayWord(): string {
  const nowPacific = new Date(new Date().toLocaleString("en-US", { timeZone: VENUE_TIMEZONE }));
  const hour = nowPacific.getHours();
  if (hour < 12) return "Morning";
  if (hour < 17) return "Afternoon";
  return "Evening";
}

function applyTimeOfDayLabels<T extends { theme: Theme }>(items: T[]): T[] {
  const word = currentTimeOfDayWord();
  return items.map((c) => {
    if (!/^Morning\b/.test(c.theme.label)) return c;
    const label = c.theme.label.replace(/^Morning\b/, word);
    return { ...c, theme: { ...c.theme, label } };
  });
}

// Unknown hours (no regularOpeningHours in the Places response) fall back
// to "assume open" — a missing data point shouldn't block venue offering
// the way a confirmed-closed status should.
function isOpenOrClosingSoon(hours: VenueHours | null): { open: boolean; closingSoon: boolean } {
  if (!hours || !hours.length) return { open: true, closingSoon: false };
  const regular = hours.find((h) => h.hour_type === "REGULAR") ?? hours[0];
  // is_open_now is derived directly from Google's own openNow flag
  // (see googleHoursToVenueHours()) — trusted directly rather than
  // re-derived from the `open` array, which sidesteps any ambiguity in
  // exactly how day-of-week is indexed there. The `open` array is only
  // parsed below for the "closing soon" lookahead, which isn't returned
  // as a flag by either provider.
  if (!regular.is_open_now) return { open: false, closingSoon: false };

  const nowPacific = new Date(new Date().toLocaleString("en-US", { timeZone: VENUE_TIMEZONE }));
  // This file's internal day field stays Yelp's original convention:
  // 0=Monday..6=Sunday (googleHoursToVenueHours() converts Google's
  // 0=Sunday native format into this on the way in). JS Date#getDay() is
  // 0=Sunday..6=Saturday, hence the shift.
  const weekday = (nowPacific.getDay() + 6) % 7;
  const minutesNow = nowPacific.getHours() * 60 + nowPacific.getMinutes();

  for (const block of regular.open.filter((o) => o.day === weekday)) {
    // Skip overnight blocks (span past midnight) rather than risk a wrong
    // closing-soon read from them — is_open_now above already confirmed
    // the venue is open right now regardless.
    if (block.is_overnight) continue;
    const endMinutes = parseInt(block.end.slice(0, 2), 10) * 60 + parseInt(block.end.slice(2), 10);
    if (minutesNow <= endMinutes && endMinutes - minutesNow <= CLOSING_SOON_BUFFER_MINUTES) {
      return { open: true, closingSoon: true };
    }
  }
  return { open: true, closingSoon: false };
}

// Wraps pickContrastingChoices with the open/closing-soon filter — picks
// candidates, checks each one's hours (already attached to the candidate
// from the Places search that found it — see searchNearbyVenues()), keeps
// the open ones, and asks for more from the remaining pool until n are
// filled or the pool/attempt budget runs out. Never returns a closed or
// closing-soon venue; may return fewer than n if the area genuinely
// doesn't have enough currently-open options.
function pickOpenChoices(
  candidates: Candidate[],
  n: number,
  buckets: (Theme & { keywords: string[] })[],
  maxAttempts = 8,
): (Candidate & { theme: Theme; hours: VenueHours | null })[] {
  const excludedIds = new Set<string>();
  const result: (Candidate & { theme: Theme; hours: VenueHours | null })[] = [];

  for (let attempt = 0; attempt < maxAttempts && result.length < n; attempt++) {
    const pool = candidates.filter((c) => !excludedIds.has(c.id));
    if (!pool.length) break;
    const picked = pickContrastingChoices(pool, n - result.length, buckets);
    if (!picked.length) break;

    for (const choice of picked) {
      excludedIds.add(choice.id); // never reconsider this exact candidate again, open or not
      const status = isOpenOrClosingSoon(choice.hours);
      if (status.open && !status.closingSoon) {
        result.push(choice);
        if (result.length >= n) break;
      }
    }
  }

  // diversifyLabels() first, THEN applyTimeOfDayLabels() — order matters:
  // diversifying can pull an alternate straight from
  // THEME_VARIANT_ALTERNATES's static "Morning Bite"-style text, so the
  // time-of-day swap has to run last, on whatever label actually ends up
  // on screen (primary or alternate), not before diversifying picks one.
  // diversifyLabels() belongs on the final merged result, not inside
  // pickContrastingChoices() itself — a closed pick from attempt 1 gets
  // silently dropped and re-requested on attempt 2, and each attempt calls
  // pickContrastingChoices() independently with no memory of labels an
  // earlier attempt already placed into `result`. Diversifying per-attempt
  // meant two same-theme picks landing in different attempts still showed
  // the identical label, which is exactly the bug this was meant to fix.
  const diversified = applyTimeOfDayLabels(diversifyLabels(result));
  const primaryKeys = THEME_SET_META.get(buckets)?.primaryKeys;
  if (!primaryKeys) return diversified;

  // Bucket sets with a primaryKeys set (currently only Wine Country) bubble
  // their headline theme up to card 1. Array.sort is stable, so this only
  // ever moves primary-themed entries forward as a block — it never
  // reshuffles the relative order among the rest.
  return [...diversified].sort((a, b) => {
    const aFirst = primaryKeys.has(a.theme.key) ? 0 : 1;
    const bFirst = primaryKeys.has(b.theme.key) ? 0 : 1;
    return aFirst - bFirst;
  });
}

// Records that these venues were offered as fork choices — the
// impressions half of the impressions/conversions data the admin
// dashboard's venue-performance table (and eventually partner ROI
// reporting) is built on. Best-effort: logging failures must never break
// the actual offer response, same spirit as this file's badge/notification
// side-effects elsewhere.
async function logVenueOffers(
  admin: Admin,
  choices: (Candidate & { theme: Theme })[],
  routeStopId: string,
  adventureId: string | null,
): Promise<void> {
  if (!choices.length) return;
  try {
    const { error } = await admin.from("venue_offer_events").insert(
      choices.map((c) => ({
        venue_id: c.id,
        route_stop_id: routeStopId,
        adventure_id: adventureId,
        theme_key: c.theme?.key ?? null,
      })),
    );
    if (error) console.error("venue_offer_events insert failed:", error.message);
  } catch (e) {
    console.error("logVenueOffers threw:", e);
  }
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

  const placesServerKey = Deno.env.get("GOOGLE_PLACES_SERVER_KEY");
  if (!placesServerKey) {
    return jsonResponse({ error: "GOOGLE_PLACES_SERVER_KEY is not configured for this project yet." }, 501);
  }
  const placesPhotoKey = Deno.env.get("GOOGLE_PLACES_PHOTO_KEY");
  if (!placesPhotoKey) {
    return jsonResponse({ error: "GOOGLE_PLACES_PHOTO_KEY is not configured for this project yet." }, 501);
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
    return jsonResponse({ error: "Your session has expired. Sign in again." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action;

  // ---------------------------------------------------------------
  // ensureParty — returns the caller's existing party, creating one if
  // this is their first adventure. Moved server-side (admin client,
  // bypasses RLS) after the equivalent client-side path — a plain
  // authenticated INSERT into parties with created_by = auth.uid() —
  // was reproducibly rejected by Postgres's RLS check even though every
  // individual piece (active role, auth.uid(), the with-check text)
  // checked out correctly in isolation when tested directly against the
  // database. Rather than keep chasing what looks like a genuine
  // platform-level anomaly, this sidesteps it entirely — and it's more
  // consistent with how the rest of this function already creates
  // routes/route_stops/adventures via the admin client anyway.
  // ---------------------------------------------------------------
  if (action === "ensureParty") {
    const { data: memberRows, error: memberErr } = await admin
      .from("party_members")
      .select("party_id")
      .eq("profile_id", userId)
      .limit(1);
    if (memberErr) return jsonResponse({ error: memberErr.message }, 400);

    let partyId = memberRows && memberRows[0] ? memberRows[0].party_id : null;
    if (!partyId) {
      const { data: profile } = await admin
        .from("profiles")
        .select("display_name")
        .eq("id", userId)
        .maybeSingle();
      const { data: party, error: partyErr } = await admin
        .from("parties")
        .insert({ name: `${profile?.display_name || "Explorer"}'s Crew`, created_by: userId })
        .select("id")
        .single();
      if (partyErr) return jsonResponse({ error: partyErr.message }, 400);
      partyId = party.id;

      const { error: memberInsertErr } = await admin
        .from("party_members")
        .insert({ party_id: partyId, profile_id: userId, role: "owner" });
      if (memberInsertErr) return jsonResponse({ error: memberInsertErr.message }, 400);
    }

    return jsonResponse({ partyId });
  }

  // ---------------------------------------------------------------
  // leaveAdventure — lets a player abandon their current in-progress
  // adventure (curated or real-venue) so they can start a fresh one.
  // Server-side (admin client) for the same reason ensureParty is: there's
  // no UPDATE policy on adventures at all (only select/insert), so a
  // direct client-side update would be rejected outright.
  // ---------------------------------------------------------------
  if (action === "leaveAdventure") {
    const adventureId = typeof body.adventureId === "string" ? body.adventureId : null;
    if (!adventureId) return jsonResponse({ error: "adventureId is required" }, 400);

    const { data: adventure, error: advErr } = await admin
      .from("adventures")
      .select("id, party_id, status")
      .eq("id", adventureId)
      .maybeSingle();
    if (advErr || !adventure) return jsonResponse({ error: "Adventure not found." }, 404);
    if (!(await isPartyMember(admin, adventure.party_id, userId))) {
      return jsonResponse({ error: "You're not a member of that party." }, 403);
    }
    if (adventure.status !== "in_progress") {
      return jsonResponse({ error: "This adventure isn't in progress anymore." }, 400);
    }

    const { error: updateErr } = await admin
      .from("adventures")
      .update({ status: "abandoned" })
      .eq("id", adventureId);
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);

    return jsonResponse({ ok: true });
  }

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

    // Themed adventures (Wine Country, Dog Friendly, Outdoor, Oddities,
    // Foodies) lock search to their own category set and swap in their own
    // mood buckets, overriding the player's normal interests-derived
    // categories rather than adding to them. Persisted on the route so
    // advance()/reroll() reapply the same lock on every later stop of this
    // same adventure.
    const venueTheme = typeof body.venueTheme === "string" && THEME_REGISTRY[body.venueTheme] ? body.venueTheme : null;
    const themeEntry = venueTheme ? THEME_REGISTRY[venueTheme] : null;
    const radiusMiles = Math.min(prefs.radiusMiles || DEFAULT_RADIUS_MILES, profile.unlocked_radius_miles ?? DEFAULT_RADIUS_MILES);
    const categories = themeEntry ? themeEntry.googleTypes : resolveGoogleTypes(prefs);
    const buckets = themeEntry ? themeEntry.buckets : THEME_BUCKETS;

    const candidates = await searchNearbyVenues(admin, placesServerKey, placesPhotoKey, {
      lat, lng, radiusMiles, budget: prefs.budget, categories,
    });
    if (!candidates.length) {
      return jsonResponse({ error: "No matching venues found nearby. Try widening your search radius in preferences." }, 404);
    }

    // Every adventure defaults to 3 stops — a party can drop to 2 for a
    // shorter outing, but never below that, and never above whatever their
    // profile's unlock tier allows (unlocked_stop_count is the same "how
    // many stops can this player generate/see" ceiling route-detail uses
    // for curated routes).
    const unlockedCap = profile.unlocked_stop_count ?? 3;
    const requestedStopCount = Number(body.stopCount);
    const stopCount = Number.isInteger(requestedStopCount)
      ? Math.min(Math.max(requestedStopCount, 2), unlockedCap)
      : unlockedCap;
    const choices = pickOpenChoices(candidates, 3, buckets);
    if (!choices.length) {
      return jsonResponse({ error: "No currently-open venues nearby right now. Try again shortly." }, 404);
    }
    const offeredIds = new Set(choices.map((c) => c.id));
    const remainingPool = candidates.filter((c) => !offeredIds.has(c.id));

    const { data: route, error: routeErr } = await admin
      .from("routes")
      .insert({
        owner_party_id: partyId,
        twist_key: "real-auto",
        title: themeEntry ? themeEntry.title : "Real Venues Adventure",
        description: themeEntry ? themeEntry.description : "A fork in the road at every stop. Pick your path from real, live nearby venues.",
        venue_theme: venueTheme,
      })
      .select("id")
      .single();
    if (routeErr || !route) return jsonResponse({ error: routeErr?.message ?? "Could not create route" }, 400);

    const stopRows = [
      {
        route_id: route.id,
        venue_id: null,
        stop_order: 1,
        name: "Choose Your Path",
        description: null,
        is_mystery: false,
        offered_choices: choices,
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
        offered_choices: null,
      })),
    ];

    const { data: stops, error: stopsErr } = await admin
      .from("route_stops")
      .insert(stopRows)
      .select("id, stop_order, name, is_mystery, venue_id, offered_choices");
    if (stopsErr) return jsonResponse({ error: stopsErr.message }, 400);

    const { data: adventure, error: advErr } = await admin
      .from("adventures")
      .insert({ party_id: partyId, route_id: route.id, stop_count: stopCount, mode: "real_venue" })
      .select("id, route_id, stop_count, mode")
      .single();
    if (advErr) return jsonResponse({ error: advErr.message }, 400);

    if (stops && stops[0]) await logVenueOffers(admin, choices, stops[0].id, adventure.id);

    return jsonResponse({ adventure, routeId: route.id, stops });
  }

  // ---------------------------------------------------------------
  // reroll — regenerates the 3 offered (not yet chosen) choices for a stop
  // ---------------------------------------------------------------
  if (action === "reroll") {
    const routeStopId = typeof body.routeStopId === "string" ? body.routeStopId : null;
    if (!routeStopId) return jsonResponse({ error: "routeStopId is required" }, 400);

    const { data: stop, error: stopErr } = await admin
      .from("route_stops")
      .select("id, route_id, venue_id, is_mystery, reroll_count, candidate_pool, offered_choices, routes!inner(owner_party_id, venue_theme)")
      .eq("id", routeStopId)
      .maybeSingle();
    if (stopErr || !stop) return jsonResponse({ error: "Stop not found." }, 404);

    const stopRoute = (stop as unknown as { routes: { owner_party_id: string | null; venue_theme: string | null } }).routes;
    const ownerPartyId = stopRoute?.owner_party_id;
    if (!ownerPartyId || !(await isPartyMember(admin, ownerPartyId, userId))) {
      return jsonResponse({ error: "You're not a member of that party." }, 403);
    }
    const rerollBuckets = stopRoute?.venue_theme ? (THEME_REGISTRY[stopRoute.venue_theme]?.buckets ?? THEME_BUCKETS) : THEME_BUCKETS;
    // Reroll only makes sense while choices are offered and nothing's been
    // committed yet — once venue_id is set the fork has already been taken.
    if (stop.is_mystery || stop.venue_id || !stop.offered_choices) {
      return jsonResponse({ error: "This stop doesn't have choices to reroll right now." }, 400);
    }

    const { data: existingCheckIn } = await admin
      .from("check_ins")
      .select("id")
      .eq("route_stop_id", routeStopId)
      .maybeSingle();
    if (existingCheckIn) {
      return jsonResponse({ error: "You've already checked in here." }, 400);
    }

    const pool = (stop.candidate_pool ?? []) as Candidate[];
    if (!pool.length) {
      return jsonResponse({ error: "No other nearby venues to roll into right now." }, 404);
    }

    // Pick (and hours-verify) choices BEFORE touching coins/reroll_count —
    // a spin that comes back with nothing open shouldn't cost the player
    // anything.
    const choices = pickOpenChoices(pool, 3, rerollBuckets);
    if (!choices.length) {
      return jsonResponse({ error: "No currently-open venues nearby right now. Try again shortly." }, 404);
    }

    const rerollCount = stop.reroll_count ?? 0;
    let spent = 0;
    if (rerollCount >= FREE_REROLLS) {
      // Real-venue routes are 1:1 with the adventure that created them, so
      // this always resolves to exactly the adventure this reroll belongs
      // to — derived server-side rather than trusted from the client.
      const { data: advRow } = await admin
        .from("adventures")
        .select("id")
        .eq("route_id", stop.route_id)
        .maybeSingle();

      const { data: success, error: debitErr } = await admin.rpc("debit_coins", {
        p_profile_id: userId,
        p_amount: EXTRA_ROLL_COST,
        p_reason: "extra_roll",
        p_adventure_id: advRow?.id ?? null,
      });
      if (debitErr) return jsonResponse({ error: debitErr.message }, 400);
      if (!success) {
        return jsonResponse({ error: `Not enough Adventure Coins. Need ${EXTRA_ROLL_COST} for another roll.` }, 402);
      }
      spent = EXTRA_ROLL_COST;
    }

    const offeredIds = new Set(choices.map((c) => c.id));
    const newPool = pool.filter((c) => !offeredIds.has(c.id));

    const { data: updated, error: updateErr } = await admin
      .from("route_stops")
      .update({
        offered_choices: choices,
        reroll_count: rerollCount + 1,
        candidate_pool: newPool,
      })
      .eq("id", routeStopId)
      .select("id, name, description, venue_id, reroll_count, offered_choices")
      .single();
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);

    // adventure_id intentionally left null here — reroll doesn't otherwise
    // need to look up the adventure row (only the coin-debit branch above
    // does, and only when the free-roll allowance is used up), and
    // venue_offer_events' aggregates group by venue, not by adventure, so
    // this lineage field isn't load-bearing for the dashboard.
    await logVenueOffers(admin, choices, routeStopId, null);

    return jsonResponse({
      stop: updated,
      spent,
      freeRollsRemaining: Math.max(FREE_REROLLS - (rerollCount + 1), 0),
    });
  }

  // ---------------------------------------------------------------
  // choose — commits one of a stop's offered choices as the real venue
  // ---------------------------------------------------------------
  if (action === "choose") {
    const routeStopId = typeof body.routeStopId === "string" ? body.routeStopId : null;
    const venueId = typeof body.venueId === "string" ? body.venueId : null;
    if (!routeStopId || !venueId) {
      return jsonResponse({ error: "routeStopId and venueId are required" }, 400);
    }

    const { data: stop, error: stopErr } = await admin
      .from("route_stops")
      .select("id, venue_id, is_mystery, offered_choices, routes!inner(owner_party_id)")
      .eq("id", routeStopId)
      .maybeSingle();
    if (stopErr || !stop) return jsonResponse({ error: "Stop not found." }, 404);

    const ownerPartyId = (stop as unknown as { routes: { owner_party_id: string | null } }).routes?.owner_party_id;
    if (!ownerPartyId || !(await isPartyMember(admin, ownerPartyId, userId))) {
      return jsonResponse({ error: "You're not a member of that party." }, 403);
    }
    if (stop.is_mystery || stop.venue_id || !stop.offered_choices) {
      return jsonResponse({ error: "This stop doesn't have choices to pick from right now." }, 400);
    }

    // Never trust venueId alone — it must be one of the choices this exact
    // stop actually offered server-side, not just any venue id a tampered
    // client might send.
    const choices = (stop.offered_choices ?? []) as (Candidate & { theme: Theme })[];
    const picked = choices.find((c) => c.id === venueId);
    if (!picked) {
      return jsonResponse({ error: "That wasn't one of the offered choices." }, 400);
    }

    const { data: updated, error: updateErr } = await admin
      .from("route_stops")
      .update({
        venue_id: picked.id,
        name: picked.name,
        description: [picked.category, picked.address].filter(Boolean).join(" · "),
        offered_choices: null,
        chosen_theme_key: picked.theme?.key ?? null,
      })
      .eq("id", routeStopId)
      .select("id, name, description, venue_id")
      .single();
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);

    // Best-effort — flips this venue's most recent offer-event for this
    // stop to "chosen," the conversion half of the impressions/conversions
    // data the admin dashboard's venue-performance table reads from. A
    // failure here shouldn't undo an already-successful choice.
    try {
      const { error: offerUpdateErr } = await admin
        .from("venue_offer_events")
        .update({ chosen: true, chosen_at: new Date().toISOString() })
        .eq("route_stop_id", routeStopId)
        .eq("venue_id", picked.id)
        .eq("chosen", false);
      if (offerUpdateErr) console.error("venue_offer_events chosen-update failed:", offerUpdateErr.message);
    } catch (e) {
      console.error("venue_offer_events chosen-update threw:", e);
    }

    return jsonResponse({ stop: updated });
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
      .select("id, party_id, route_id, mode, routes(venue_theme)")
      .eq("id", adventureId)
      .maybeSingle();
    if (advErr || !adventure) return jsonResponse({ error: "Adventure not found." }, 404);
    if (adventure.mode !== "real_venue") {
      return jsonResponse({ error: "This isn't a real-venue adventure." }, 400);
    }
    if (!(await isPartyMember(admin, adventure.party_id, userId))) {
      return jsonResponse({ error: "You're not a member of that party." }, 403);
    }
    const advanceVenueTheme = (adventure as unknown as { routes: { venue_theme: string | null } | null }).routes?.venue_theme;
    const advanceThemeEntry = advanceVenueTheme ? THEME_REGISTRY[advanceVenueTheme] : null;

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
    const categories = advanceThemeEntry ? advanceThemeEntry.googleTypes : resolveGoogleTypes(prefs);
    const buckets = advanceThemeEntry ? advanceThemeEntry.buckets : THEME_BUCKETS;

    const alreadyVisitedVenueIds = new Set(stops.filter((s) => s.venue_id).map((s) => s.venue_id as string));

    const candidates = await searchNearbyVenues(admin, placesServerKey, placesPhotoKey, {
      lat, lng, radiusMiles, budget: prefs.budget, categories,
    });
    const fresh = candidates.filter((c) => !alreadyVisitedVenueIds.has(c.id));
    if (!fresh.length) {
      return jsonResponse({ error: "No new nearby venues found for the next stop. Try again shortly." }, 404);
    }

    const choices = pickOpenChoices(fresh, 3, buckets);
    if (!choices.length) {
      return jsonResponse({ error: "No currently-open venues nearby right now. Try again shortly." }, 404);
    }
    const offeredIds = new Set(choices.map((c) => c.id));
    const remainingPool = fresh.filter((c) => !offeredIds.has(c.id));

    const { data: updated, error: updateErr } = await admin
      .from("route_stops")
      .update({
        is_mystery: false,
        offered_choices: choices,
        candidate_pool: remainingPool,
      })
      .eq("id", nextPlaceholder.id)
      .select("id, stop_order, name, description, venue_id, offered_choices")
      .single();
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);

    await logVenueOffers(admin, choices, nextPlaceholder.id, adventureId);

    return jsonResponse({ stop: updated, done: false });
  }

  return jsonResponse({ error: "action must be 'init', 'reroll', 'advance', or 'choose'" }, 400);
});
