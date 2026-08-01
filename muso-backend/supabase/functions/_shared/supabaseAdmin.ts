import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Service-role client for use ONLY inside edge functions. This bypasses RLS,
// so every function using it must do its own authorization checks (verifying
// the caller's JWT / party membership) before touching data on their behalf.
export function getSupabaseAdmin() {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not configured");
  }

  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Client scoped to the calling user's JWT — respects RLS. Use this whenever
// possible so Postgres itself enforces "you can only touch your own party's
// data," and only fall back to the admin client for steps that legitimately
// need to cross that boundary (e.g. reading a venue contact's email).
export function getSupabaseAsUser(req: Request) {
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
