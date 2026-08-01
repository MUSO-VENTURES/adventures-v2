// GET /route-detail?routeId=...
//
// Returns a route and its ordered stops for the itinerary reveal UI.
// Mystery stops (is_mystery = true) have their name/description masked
// until check-in, mirroring the "Unknown Location" behavior on the
// landing page demo.
//
// Free-tier stop cap (0011_stop_unlock.sql): every player's
// unlocked_stop_count defaults to 3. Stops beyond that (stop_order >
// unlockedStopCount) are withheld entirely from the `stops` array rather
// than sent-but-masked, so there's nothing in the response for a client to
// bypass the paywall with. The response's `unlockedStopCount`/`totalStops`/
// `locked` fields let the client render an honest "N more stops available"
// teaser and drive the unlock-feature('extra_stops') CTA.

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

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const routeId = url.searchParams.get("routeId");
  if (!routeId) {
    return jsonResponse({ error: "routeId is required" }, 400);
  }

  let client;
  try {
    client = getSupabaseAsUser(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  const { data: route, error: routeErr } = await client
    .from("routes")
    .select("id, title, description, twist_key, stop_count_options, is_sponsored")
    .eq("id", routeId)
    .single();

  if (routeErr || !route) {
    return jsonResponse({ error: routeErr?.message ?? "Route not found" }, 404);
  }

  const { data: stops, error: stopsErr } = await client
    .from("route_stops")
    .select("id, stop_order, name, description, emoji, is_mystery")
    .eq("route_id", routeId)
    .order("stop_order", { ascending: true });

  if (stopsErr) {
    return jsonResponse({ error: stopsErr.message }, 400);
  }

  // Self-row read, already allowed by the existing profiles RLS policy for
  // the authenticated caller — no service role needed here.
  const { data: userData } = await client.auth.getUser();
  const userId = userData?.user?.id;

  let unlockedStopCount = 3;
  if (userId) {
    const { data: profile } = await client
      .from("profiles")
      .select("unlocked_stop_count")
      .eq("id", userId)
      .maybeSingle();
    unlockedStopCount = profile?.unlocked_stop_count ?? 3;
  }

  const totalStops = (stops ?? []).length;
  const visibleStops = (stops ?? []).filter((s) => (s.stop_order as number) <= unlockedStopCount);

  const itinerary = visibleStops.map((s: Record<string, unknown>) =>
    s.is_mystery
      ? { ...s, name: "Unknown Location", description: "We pick. You don't find out until you arrive." }
      : s,
  );

  return jsonResponse({
    route,
    stops: itinerary,
    unlockedStopCount,
    totalStops,
    locked: totalStops > unlockedStopCount,
  });
});
