// POST /submit-review
// Body: { checkInId: string, rating: number (1-10 int), reviewText?: string }
//
// Lets a player leave a MUSO rating + optional written review for the
// venue they just checked in at. One review per check-in — resubmitting
// against the same checkInId edits the existing review (upsert on the
// unique check_in_id constraint) rather than creating a duplicate.
//
// venues.muso_rating/muso_rating_count (separate from the Yelp-sourced
// rating/rating_count columns — see 0021_venue_reviews.sql) are recomputed
// by a database trigger on venue_reviews, not here, so the write is the
// single source of truth regardless of what else ever writes a review.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined rather than imported from ../_shared/*.ts — see checkin/index.ts's
// header comment: the Supabase dashboard's single-function editor doesn't
// reliably bundle sibling _shared files. Keep in sync with that copy.

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

function getSupabaseAsUser(req: Request) {
  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const authHeader = req.headers.get("Authorization");
  if (!url || !anonKey) {
    throw new Error("SUPABASE_URL / SUPABASE_ANON_KEY not configured");
  }
  if (!authHeader) {
    throw new Error("Missing Authorization header");
  }
  return createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let payload: { checkInId?: string; rating?: number; reviewText?: string };
  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { checkInId, reviewText } = payload;
  const rating = Number(payload.rating);

  if (!checkInId) {
    return jsonResponse({ error: "checkInId is required" }, 400);
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 10) {
    return jsonResponse({ error: "rating must be an integer from 1 to 10" }, 400);
  }

  let userClient;
  try {
    userClient = getSupabaseAsUser(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResponse({ error: "Not authenticated" }, 401);
  }
  const userId = userData.user.id;

  const admin = getSupabaseAdmin();

  // Look up the check-in to derive venue_id and confirm ownership — RLS on
  // venue_reviews itself also enforces this on the insert below, but
  // resolving it here lets us return a clean 403/404 instead of a raw RLS
  // failure, and gives us route_stops.venue_id without another round trip.
  const { data: checkIn, error: checkInErr } = await admin
    .from("check_ins")
    .select("id, checked_in_by, route_stop_id, route_stops(venue_id)")
    .eq("id", checkInId)
    .maybeSingle();

  if (checkInErr) return jsonResponse({ error: checkInErr.message }, 400);
  if (!checkIn) return jsonResponse({ error: "Check-in not found" }, 404);
  if (checkIn.checked_in_by !== userId) {
    return jsonResponse({ error: "You can only review your own check-ins" }, 403);
  }

  const venueId = (checkIn as any).route_stops?.venue_id as string | null;
  if (!venueId) {
    return jsonResponse({ error: "This check-in has no venue to review" }, 400);
  }

  const { data: review, error: reviewErr } = await admin
    .from("venue_reviews")
    .upsert(
      {
        check_in_id: checkInId,
        venue_id: venueId,
        profile_id: userId,
        rating,
        review_text: reviewText?.trim() || null,
      },
      { onConflict: "check_in_id" },
    )
    .select()
    .single();

  if (reviewErr) return jsonResponse({ error: reviewErr.message }, 400);

  const { data: venue } = await admin
    .from("venues")
    .select("muso_rating, muso_rating_count")
    .eq("id", venueId)
    .single();

  return jsonResponse({
    review,
    venueMusoRating: venue?.muso_rating ?? null,
    venueMusoRatingCount: venue?.muso_rating_count ?? 0,
  });
});
