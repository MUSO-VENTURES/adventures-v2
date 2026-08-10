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
// Yelp search + preference-driven filtering
// (budget/interest mappings mirror venues-search/index.ts and index.html's
// INTEREST_YELP_CATEGORIES exactly, so a player sees the same kind of
// results here as they would from "Find Real Venues.")
// ---------------------------------------------------------------

const DEFAULT_RADIUS_MILES = 15;
const YELP_MAX_RADIUS_METERS = 40000; // ~24.85 miles, Yelp's hard cap
const FREE_REROLLS = 3;
const EXTRA_ROLL_COST = 20;
// Quality floor on Yelp's own rating — only 4.0+ star venues are ever
// offered as a fork choice. Applied as a hard filter (not just a
// weightedRandomPick weighting bump) on searchNearbyVenues()'s return
// value, so every code path (init/advance/reroll) is covered from one
// place. A venue with no Yelp rating at all is excluded too — no rating
// means no way to confirm it clears the bar.
const MIN_YELP_RATING = 4.0;

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

type YelpHours = { hour_type: string; is_open_now: boolean; open: { day: number; start: string; end: string; is_overnight: boolean }[] }[];

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
  yelp_id: string | null;
  hours: YelpHours | null;
  hours_fetched_at: string | null;
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
    if (!yelpRes.ok) {
      // Was silently returning [] here — indistinguishable from a genuinely
      // empty search, so a Yelp-side failure (rate limit, bad/expired key,
      // etc.) showed players the exact same "No matching venues found
      // nearby" message as an actual empty result. Logged so the real
      // cause is visible in this function's Supabase dashboard logs.
      const errBody = await yelpRes.text().catch(() => "");
      console.error(`Yelp search failed: ${yelpRes.status} ${yelpRes.statusText} — ${errBody.slice(0, 500)}`);
      return [];
    }
    const yelpData = await yelpRes.json();
    businesses = Array.isArray(yelpData.businesses) ? yelpData.businesses : [];
    if (!businesses.length) {
      console.log(`Yelp search returned 0 businesses: lat=${opts.lat} lng=${opts.lng} radiusMeters=${radiusMeters} categories=${opts.categories.join(",") || "(none)"} price=${yelpPrice ?? "(any)"}`);
    }
  } catch (e) {
    console.error("Yelp search threw:", e);
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

  if (!rows.length) {
    console.log(`Yelp returned ${businesses.length} businesses but 0 survived the yelp_id/lat/lng filter`);
    return [];
  }

  try {
    // rows is passed as a plain array, NOT JSON.stringify(rows) — the SQL
    // function's `rows jsonb` parameter expects a genuine JSONB array.
    // Stringifying it here double-encodes it: PostgREST hands Postgres a
    // JSON *string* whose contents happen to look like an array, which
    // Postgres casts to a JSONB scalar (a string), not a JSONB array — so
    // jsonb_array_elements(rows) inside the function failed on every call
    // with "cannot extract elements from a scalar", silently caught below
    // and surfacing to players as "No matching venues found nearby."
    const { error: upsertErr } = await admin.rpc("upsert_yelp_venues", { rows });
    if (upsertErr) {
      console.error("upsert_yelp_venues RPC error:", JSON.stringify(upsertErr));
      return [];
    }
  } catch (e) {
    console.error("upsert_yelp_venues threw:", e);
    return [];
  }

  const { data: candidates, error: nearbyErr } = await admin.rpc("nearby_candidate_venues", {
    p_lat: opts.lat,
    p_lng: opts.lng,
    p_radius_miles: opts.radiusMiles,
    p_yelp_ids: rows.map((r) => r.yelp_id),
  });
  if (nearbyErr) {
    console.error("nearby_candidate_venues RPC error:", JSON.stringify(nearbyErr));
    return [];
  }
  if (!candidates?.length) {
    console.log(`nearby_candidate_venues returned 0 rows for ${rows.length} upserted yelp_ids, radius=${opts.radiusMiles}mi, lat=${opts.lat}, lng=${opts.lng}`);
  }

  const allCandidates = (candidates ?? []) as Candidate[];
  // "Preferably good photos, but not limited to good photos" — there's no
  // reliable signal for photo *quality* from the Yelp search response
  // (just the one representative image_url), so the bar is "has a real
  // photo at all," not an aesthetic judgment call.
  const withPhotoAndRating = allCandidates.filter(
    (c) => c.rating != null && c.rating >= MIN_YELP_RATING && !!c.image_url,
  );
  if (withPhotoAndRating.length < allCandidates.length) {
    console.log(`Filtered out ${allCandidates.length - withPhotoAndRating.length} of ${allCandidates.length} candidates (below ${MIN_YELP_RATING} stars or missing a photo)`);
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

// Wine Country Adventure — every candidate is already a winery/tasting
// room (locked via WINE_YELP_CATEGORIES below), so the general mood
// buckets above (cozy/adventurous/social/artsy/foodie) would barely
// differentiate anything. This parallel bucket set classifies by the
// *kind* of wine venue instead, matched against Yelp's category/name text.
const WINE_YELP_CATEGORIES = ["wineries", "wine_bars"];
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
];
const WINE_GENERAL_THEME: Theme = { key: "winery", label: "Winery", emoji: "🍷", color: "#2a2438" };

function classifyTheme(candidate: Candidate, buckets: (Theme & { keywords: string[] })[] = THEME_BUCKETS): Theme {
  const cat = `${candidate.category ?? ""} ${candidate.name ?? ""}`.toLowerCase();
  for (const bucket of buckets) {
    if (bucket.keywords.some((kw) => cat.includes(kw))) {
      const { keywords: _keywords, ...theme } = bucket;
      return theme;
    }
  }
  return buckets === WINE_THEME_BUCKETS ? WINE_GENERAL_THEME : GENERAL_THEME;
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

const HOURS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — hours change rarely; avoids re-fetching Yelp Business Details on every search near the same venue
const CLOSING_SOON_BUFFER_MINUTES = 30;
// Every current/planned venue (Tri-Valley, Napa, Mendocino, Lake County) is
// in Pacific time — hardcoded rather than adding a timezone-lookup
// dependency for a case that doesn't exist yet. Revisit if this ever
// expands outside California.
const VENUE_TIMEZONE = "America/Los_Angeles";

// Fetches (or reuses a cached, <24h-old) Yelp Business Details record for
// one candidate's hours. Only the Business Details endpoint returns hours
// — the Search endpoint used above doesn't — so this is a second,
// per-candidate Yelp call, deliberately only made lazily for candidates
// actually about to be offered (see pickOpenChoices below), not the whole
// search result set, to keep Yelp quota usage bounded.
async function getVenueHours(admin: Admin, yelpKey: string, candidate: Candidate): Promise<YelpHours | null> {
  if (candidate.hours && candidate.hours_fetched_at) {
    const age = Date.now() - new Date(candidate.hours_fetched_at).getTime();
    if (age < HOURS_CACHE_TTL_MS) return candidate.hours;
  }
  if (!candidate.yelp_id) return candidate.hours ?? null; // nothing to look up against — best-effort fall back to whatever's cached, else unknown

  try {
    const res = await fetch(`https://api.yelp.com/v3/businesses/${encodeURIComponent(candidate.yelp_id)}`, {
      headers: { Authorization: `Bearer ${yelpKey}` },
    });
    if (!res.ok) {
      console.error(`Yelp business details failed for ${candidate.yelp_id}: ${res.status} ${res.statusText}`);
      return candidate.hours ?? null;
    }
    const data = await res.json();
    const hours = Array.isArray(data.hours) ? (data.hours as YelpHours) : null;
    // Best-effort cache write — a failure here shouldn't break venue
    // offering, it just means the next request re-fetches instead of
    // hitting cache.
    await admin.from("venues").update({ hours, hours_fetched_at: new Date().toISOString() }).eq("id", candidate.id);
    return hours;
  } catch (e) {
    console.error("Yelp business details threw:", e);
    return candidate.hours ?? null;
  }
}

// Unknown hours (Yelp lookup failed, or no yelp_id) fall back to "assume
// open" — a missing data point shouldn't block venue offering the way a
// confirmed-closed status should.
function isOpenOrClosingSoon(hours: YelpHours | null): { open: boolean; closingSoon: boolean } {
  if (!hours || !hours.length) return { open: true, closingSoon: false };
  const regular = hours.find((h) => h.hour_type === "REGULAR") ?? hours[0];
  // is_open_now is Yelp's own authoritative "is it open right now"
  // computation — trusted directly rather than re-derived from the `open`
  // array, which sidesteps any ambiguity in exactly how Yelp indexes
  // day-of-week there. The `open` array is only parsed below for the
  // "closing soon" lookahead, which Yelp doesn't provide as a flag.
  if (!regular.is_open_now) return { open: false, closingSoon: false };

  const nowPacific = new Date(new Date().toLocaleString("en-US", { timeZone: VENUE_TIMEZONE }));
  // Yelp's day field: 0=Monday..6=Sunday (confirmed against Yelp's own
  // docs). JS Date#getDay() is 0=Sunday..6=Saturday, hence the shift.
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
// candidates, checks each one's hours (lazily, only the ones actually
// picked), keeps the open ones, and asks for more from the remaining pool
// until n are filled or the pool/attempt budget runs out. Never returns a
// closed or closing-soon venue; may return fewer than n if the area
// genuinely doesn't have enough currently-open options.
async function pickOpenChoices(
  admin: Admin,
  yelpKey: string,
  candidates: Candidate[],
  n: number,
  buckets: (Theme & { keywords: string[] })[],
  maxAttempts = 8,
): Promise<(Candidate & { theme: Theme; hours: YelpHours | null })[]> {
  const excludedIds = new Set<string>();
  const result: (Candidate & { theme: Theme; hours: YelpHours | null })[] = [];

  for (let attempt = 0; attempt < maxAttempts && result.length < n; attempt++) {
    const pool = candidates.filter((c) => !excludedIds.has(c.id));
    if (!pool.length) break;
    const picked = pickContrastingChoices(pool, n - result.length, buckets);
    if (!picked.length) break;

    for (const choice of picked) {
      excludedIds.add(choice.id); // never reconsider this exact candidate again, open or not
      const hours = await getVenueHours(admin, yelpKey, choice);
      const status = isOpenOrClosingSoon(hours);
      if (status.open && !status.closingSoon) {
        result.push({ ...choice, hours });
        if (result.length >= n) break;
      }
    }
  }

  return result;
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

    // Wine Country Adventure — locks search to wineries/tasting rooms and
    // swaps in wine-specific mood buckets, overriding the player's normal
    // interests-derived categories rather than adding to them. Persisted
    // on the route so advance()/reroll() reapply the same lock on every
    // later stop of this same adventure.
    const venueTheme = body.venueTheme === "wine_country" ? "wine_country" : null;
    const isWineCountry = venueTheme === "wine_country";
    const radiusMiles = Math.min(prefs.radiusMiles || DEFAULT_RADIUS_MILES, profile.unlocked_radius_miles ?? DEFAULT_RADIUS_MILES);
    const categories = isWineCountry ? WINE_YELP_CATEGORIES : resolveYelpCategories(prefs);
    const buckets = isWineCountry ? WINE_THEME_BUCKETS : THEME_BUCKETS;

    const candidates = await searchNearbyVenues(admin, yelpKey, {
      lat, lng, radiusMiles, budget: prefs.budget, categories,
    });
    if (!candidates.length) {
      return jsonResponse({ error: "No matching venues found nearby — try widening your search radius in preferences." }, 404);
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
    const choices = await pickOpenChoices(admin, yelpKey, candidates, 3, buckets);
    if (!choices.length) {
      return jsonResponse({ error: "No currently-open venues nearby right now — try again shortly." }, 404);
    }
    const offeredIds = new Set(choices.map((c) => c.id));
    const remainingPool = candidates.filter((c) => !offeredIds.has(c.id));

    const { data: route, error: routeErr } = await admin
      .from("routes")
      .insert({
        owner_party_id: partyId,
        twist_key: "real-auto",
        title: isWineCountry ? "Wine Country Adventure" : "Real Venues Adventure",
        description: isWineCountry
          ? "A fork in the road at every stop — pick your path through real, live nearby wineries and tasting rooms."
          : "A fork in the road at every stop — pick your path from real, live nearby venues.",
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
    const rerollBuckets = stopRoute?.venue_theme === "wine_country" ? WINE_THEME_BUCKETS : THEME_BUCKETS;
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
    const choices = await pickOpenChoices(admin, yelpKey, pool, 3, rerollBuckets);
    if (!choices.length) {
      return jsonResponse({ error: "No currently-open venues nearby right now — try again shortly." }, 404);
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
      })
      .eq("id", routeStopId)
      .select("id, name, description, venue_id")
      .single();
    if (updateErr) return jsonResponse({ error: updateErr.message }, 400);

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
    const isWineCountry = (adventure as unknown as { routes: { venue_theme: string | null } | null }).routes?.venue_theme === "wine_country";

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
    const categories = isWineCountry ? WINE_YELP_CATEGORIES : resolveYelpCategories(prefs);
    const buckets = isWineCountry ? WINE_THEME_BUCKETS : THEME_BUCKETS;

    const alreadyVisitedVenueIds = new Set(stops.filter((s) => s.venue_id).map((s) => s.venue_id as string));

    const candidates = await searchNearbyVenues(admin, yelpKey, {
      lat, lng, radiusMiles, budget: prefs.budget, categories,
    });
    const fresh = candidates.filter((c) => !alreadyVisitedVenueIds.has(c.id));
    if (!fresh.length) {
      return jsonResponse({ error: "No new nearby venues found for the next stop — try again shortly." }, 404);
    }

    const choices = await pickOpenChoices(admin, yelpKey, fresh, 3, buckets);
    if (!choices.length) {
      return jsonResponse({ error: "No currently-open venues nearby right now — try again shortly." }, 404);
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

    return jsonResponse({ stop: updated, done: false });
  }

  return jsonResponse({ error: "action must be 'init', 'reroll', 'advance', or 'choose'" }, 400);
});
