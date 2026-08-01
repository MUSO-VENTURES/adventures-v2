// POST /buy-coins
// Body: { pack: 'small' | 'medium' | 'large', successUrl: string, cancelUrl: string }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Creates a Stripe Checkout Session (test mode, as long as STRIPE_SECRET_KEY
// is a test key — sk_test_...) for a one-time Adventure Coins purchase, and
// returns the session URL for the client to redirect to. No card details
// ever touch this backend or MUSO's own code — Stripe Checkout is hosted by
// Stripe.
//
// The actual coin credit happens in stripe-webhook, triggered by Stripe once
// payment succeeds — never here. This endpoint only ever starts a payment;
// it can't credit coins itself, so a client can't fake a purchase by simply
// calling this and walking away.
//
// Requires a STRIPE_SECRET_KEY secret (Supabase dashboard > Edge Functions >
// Secrets). Use a test-mode key (starts with sk_test_) while developing —
// test-mode Checkout never moves real money regardless of what card number
// is entered. Get one from https://dashboard.stripe.com/test/apikeys.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";

const COIN_PACKS: Record<string, { coins: number; usdCents: number; label: string }> = {
  small: { coins: 100, usdCents: 99, label: "100 Adventure Coins" },
  medium: { coins: 600, usdCents: 499, label: "600 Adventure Coins" },
  large: { coins: 1500, usdCents: 999, label: "1,500 Adventure Coins" },
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
    return jsonResponse({ error: "Sign in to buy Adventure Coins." }, 401);
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

  const pack = typeof body.pack === "string" ? COIN_PACKS[body.pack] : undefined;
  if (!pack) {
    return jsonResponse({ error: "pack must be 'small', 'medium', or 'large'" }, 400);
  }
  const successUrl = typeof body.successUrl === "string" ? body.successUrl : null;
  const cancelUrl = typeof body.cancelUrl === "string" ? body.cancelUrl : null;
  if (!successUrl || !cancelUrl) {
    return jsonResponse({ error: "successUrl and cancelUrl are required" }, 400);
  }

  // Raw fetch to the Stripe REST API rather than pulling in the Stripe SDK —
  // keeps this dependency-free and consistent with how the rest of this
  // project talks to third-party APIs (see venues-search's Yelp call).
  const params = new URLSearchParams();
  params.set("mode", "payment");
  params.set("success_url", successUrl);
  params.set("cancel_url", cancelUrl);
  params.set("line_items[0][quantity]", "1");
  params.set("line_items[0][price_data][currency]", "usd");
  params.set("line_items[0][price_data][unit_amount]", String(pack.usdCents));
  params.set("line_items[0][price_data][product_data][name]", pack.label);
  params.set("metadata[profile_id]", userId);
  params.set("metadata[coins]", String(pack.coins));

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
