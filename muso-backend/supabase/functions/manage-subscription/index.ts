// POST /manage-subscription
// Body: { returnUrl: string }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Creates a Stripe Billing Portal session so a subscriber can update
// payment details or cancel MUSO Pass / MUSO Pass+ themselves, without
// MUSO needing to build any custom billing-management UI. Requires the
// caller to already have a stripe_customer_id on their profile (set by
// stripe-webhook the first time a subscription checkout completes) — if
// they've never subscribed, there's nothing to manage yet.
//
// Cancelling through the portal fires customer.subscription.updated (with
// cancel_at_period_end=true) and eventually customer.subscription.deleted
// on Stripe's side, both handled by stripe-webhook — this function itself
// never changes subscription state, same separation of concerns as
// buy-coins/subscribe vs stripe-webhook.
//
// Note: Stripe requires a Customer Portal configuration to exist for the
// account (Stripe dashboard > Settings > Billing > Customer portal, or via
// the API) before this will work — test-mode accounts usually have a
// default configuration already. If this errors with something like "No
// configuration provided", that's what to check first.
//
// Requires STRIPE_SECRET_KEY (same secret buy-coins/subscribe use).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");
  if (!stripeKey) {
    return jsonResponse({ error: "STRIPE_SECRET_KEY is not configured for this project yet." }, 501);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) {
    return jsonResponse({ error: "Sign in first." }, 401);
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

  const returnUrl = typeof body.returnUrl === "string" ? body.returnUrl : null;
  if (!returnUrl) {
    return jsonResponse({ error: "returnUrl is required" }, 400);
  }

  const { data: profile } = await admin
    .from("profiles")
    .select("stripe_customer_id")
    .eq("id", userId)
    .maybeSingle();

  if (!profile?.stripe_customer_id) {
    return jsonResponse({ error: "You don't have a MUSO Pass subscription to manage yet." }, 404);
  }

  const params = new URLSearchParams();
  params.set("customer", profile.stripe_customer_id);
  params.set("return_url", returnUrl);

  try {
    const stripeRes = await fetch("https://api.stripe.com/v1/billing_portal/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      return jsonResponse({ error: session?.error?.message ?? "Stripe error creating portal session." }, 502);
    }

    return jsonResponse({ url: session.url as string });
  } catch (e) {
    return jsonResponse({ error: `Failed to reach Stripe: ${(e as Error).message}` }, 502);
  }
});
