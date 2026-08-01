// GET /leaderboard?limit=20
//
// Reads the `leaderboard` view (see migration 0001). Public-ish read: any
// authenticated player can see ranked parties, matching the landing page's
// leaderboard section. Uses the anon/user client since the view only
// exposes aggregate counts, not sensitive data.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAsUser } from "../_shared/supabaseAdmin.ts";

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") ?? 20), 100);

  let client;
  try {
    client = getSupabaseAsUser(req);
  } catch (e) {
    return jsonResponse({ error: (e as Error).message }, 401);
  }

  const { data, error } = await client
    .from("leaderboard")
    .select("*")
    .order("adventures_completed", { ascending: false })
    .order("stops_checked_in", { ascending: false })
    .limit(limit);

  if (error) {
    return jsonResponse({ error: error.message }, 400);
  }

  const ranked = (data ?? []).map((row: Record<string, unknown>, i: number) => ({ rank: i + 1, ...row }));
  return jsonResponse({ leaderboard: ranked });
});
