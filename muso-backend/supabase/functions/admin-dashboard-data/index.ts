// GET /admin-dashboard-data
//
// Returns the full snapshot payload the internal admin dashboard
// (admin/index.html) renders — overview, demographics, gameplay,
// rankings, venue performance, and monetization. Everything is computed
// server-side by admin_dashboard_snapshot() (0025_admin_dashboard.sql),
// which is itself locked down to service_role only, so the real access
// control lives in both places: this function checks the caller is an
// admin before calling it, and the database refuses to let anyone else
// call that function directly even if they try to bypass this function.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined rather than imported from ../_shared/*.ts — see checkin/index.ts's
// header comment: the Supabase dashboard's single-function editor doesn't
// reliably bundle sibling _shared files. Keep in sync with that copy.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
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

  if (req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405);
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

  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("is_admin")
    .eq("id", userId)
    .maybeSingle();
  if (profileErr) return jsonResponse({ error: profileErr.message }, 400);
  if (!profile?.is_admin) {
    return jsonResponse({ error: "Not authorized" }, 403);
  }

  const { data: snapshot, error: snapshotErr } = await admin.rpc("admin_dashboard_snapshot");
  if (snapshotErr) return jsonResponse({ error: snapshotErr.message }, 400);

  return jsonResponse(snapshot);
});
