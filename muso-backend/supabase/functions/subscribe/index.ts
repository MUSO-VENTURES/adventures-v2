// POST /subscribe
// Body: { tier: 'pass' | 'pass_plus', successUrl: string, cancelUrl: string }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Creates a Stripe Checkout Session in subscription mode (test mode, as
// long as STRIPE_SECRET_KEY is a test key — sk_test_...) for MUSO Pass or
// MUSO Pass+, and returns the session URL for the client to redirect to.
// Same "raw fetch to the Stripe REST API" style as buy-coins — no Stripe
// SDK dependency, and no pre-created Stripe Price objects needed: the
// recurring price is passed inline via price_data[recurring][interval].
//
// This endpoint only ever STARTS a subscription. It never grants coins,
// perks, or subscription_tier/status itself — that all happens in
// stripe-webhook, off Stripe's own invoice.payment_succeeded /
// customer.subscription.* events, which is the only place those columns
// are allowed to move (see the `revoke update (...)` in
// 0013_muso_pass_subscriptions.sql). That matches exactly how
// buy-coins/stripe-webhook split responsibilities for one-time purchases.
//
// profile_id and tier are stamped onto BOTH the Checkout Session's own
// metadata AND the underlying Subscription's metadata
// (subscription_data[metadata][...]) — stripe-webhook reads the
// Subscription's metadata (fetched fresh from Stripe by subscription id)
// as the source of truth for every invoice event, so it works correctly
// even if the initial checkout.session.completed event is delayed or
// missed relative to the first invoice.payment_succeeded.
//
// Requires STRIPE_SECRET_KEY (same secret buy-coins uses). Get a test key
// at https://dashboard.stripe.com/test/apikeys.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined from ../_shared/cors.ts and ../_shared/supabaseAdmin.ts — the
// Supabase dashboard's single-file code editor doesn't reliably bundle
// _shared/*.ts imports, so each deployed function keeps its own copy here.
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

const PLANS: Record<string, { usdCents: number; label: string }> = {
  pass: { usdCents: 799, label: "MUSO Pass (monthly)" },
  pass_plus: { usdCents: 1499, label: "MUSO Pass+ (monthly)" },
};

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
    return jsonResponse({ error: "Sign in to subscribe to MUSO Pass." }, 401);
  }

  const admin = getSupabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const userId = userData?.user?.id;
  const userEmail = userData?.user?.email;
  if (userErr || !userId) {
    return jsonResponse({ error: "Your session has expired — sign in again." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const tier = typeof body.tier === "string" ? body.tier : undefined;
  const plan = tier ? PLANS[tier] : undefined;
  if (!plan) {
    return jsonResponse({ error: `tier must be one of: ${Object.keys(PLANS).join(", ")}` }, 400);
  }

  const successUrl = typeof body.successUrl === "string" ? body.successUrl : null;
  const cancelUrl = typeof body.cancelUrl === "string" ? body.cancelUrl : null;
  if (!successUrl || !cancelUrl) {
    return jsonResponse({ error: "successUrl and cancelUrl are required" }, 400);
  }

  // Don't let an already-active subscriber accidentally start a second,
  // duplicate subscription — point them at the billing portal instead.
  const { data: profile } = await admin
    .from("profiles")
    .select("subscription_tier, subscription_status")
    .eq("id", userId)
    .maybeSingle();
  if (profile?.subscription_status === "active") {
    return jsonResponse(
      {
        error: `You already have an active ${profile.subscription_tier === "pass_plus" ? "MUSO Pass+" : "MUSO Pass"} subscription. Use the manage-subscription link to change or cancel it.`,
      },
      409,
    );
  }

  const params = new URLSearchParams();
  params.set("mode", "subscription");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  if (userEmail) params.set("customer_email", userEmail);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(plan.usdCents));
  params.set("line_items[0][price_data][recurring][interval]", "month");
  params.set("line_items[0][price_data][product_data][name]", plan.label);
  params.set("metadata[profile_id]", userId);
  params.set("metadata[tier]", tier!);
  // Stamped onto the Subscription itself (not just this Checkout Session)
  // so stripe-webhook can identify profile_id/tier straight from Stripe on
  // every future invoice, without depending on this session's metadata
  // still being reachable months later.
  params.set("subscription_data[metadata][profile_id]", userId);
  params.set("subscription_data[metadata][tier]", tier!);

  try {
    const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });

    const session = await stripeRes.json();
    if (!stripeRes.ok) {
      return jsonResponse({ error: session?.error?.message ?? "Stripe error creating checkout session." }, 502);
    }

    return jsonResponse({ url: session.url as string });
  } catch (e) {
    return jsonResponse({ error: `Failed to reach Stripe: ${(e as Error).message}` }, 502);
  }
});
