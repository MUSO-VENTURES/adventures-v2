// POST /stripe-webhook
// Configured in the Stripe dashboard (Developers > Webhooks) to point at
// this function's URL. Needs to be subscribed to these events:
//   checkout.session.completed   — one-time coin purchases (buy-coins) AND
//                                   the initial sync for a new subscription
//                                   (subscribe).
//   invoice.payment_succeeded    — the ONE place that ever grants MUSO
//                                   Pass/Pass+ coins + perks — fires for
//                                   the very first invoice and every
//                                   monthly renewal alike (see
//                                   grant_subscription_period() in
//                                   0013_muso_pass_subscriptions.sql).
//   customer.subscription.updated
//   customer.subscription.deleted
//
// This is the ONLY place Adventure Coins are ever credited, and the ONLY
// place subscription_tier/subscription_status ever change — buy-coins and
// subscribe only ever START a Stripe Checkout Session, they never mutate
// those columns themselves (both are revoked from `authenticated` in
// 0007_gamification.sql / 0013_muso_pass_subscriptions.sql).
//
// Verifies the Stripe-Signature header against STRIPE_WEBHOOK_SECRET before
// trusting the payload, per Stripe's documented scheme:
// https://docs.stripe.com/webhooks#verify-manually
//
// One-time purchases stay idempotent via the unique index on
// coin_transactions.stripe_payment_intent_id (0007_gamification.sql).
// Subscription grants stay idempotent via subscription_invoice_grants'
// primary key on stripe_invoice_id, enforced inside
// grant_subscription_period() (0013_muso_pass_subscriptions.sql) — either
// way, a retried webhook delivery can never double-credit.
//
// Requires STRIPE_WEBHOOK_SECRET (shown once when you create the webhook
// endpoint in the Stripe dashboard — starts with whsec_) and
// STRIPE_SECRET_KEY (same one buy-coins/subscribe use — needed here to
// look up a Subscription's metadata straight from Stripe on every invoice,
// so grants work correctly even if this function's own DB state is behind).

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

// tier -> monthly grant amounts, mirrors the /shop/ page and the coin
// economy pricing model exactly.
const SUBSCRIPTION_PLANS: Record<string, { coins: number; rerouteTokens: number; rewardRedemptions: number; badgeKey: string }> = {
  pass: { coins: 750, rerouteTokens: 3, rewardRedemptions: 0, badgeKey: "muso_pass_member" },
  pass_plus: { coins: 1800, rerouteTokens: 3, rewardRedemptions: 1, badgeKey: "muso_pass_plus_member" },
};

async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, v];
    }),
  );
  const timestamp = parts["t"];
  const signature = parts["v1"];
  if (!timestamp || !signature) return false;

  const signedPayload = `${timestamp}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload));
  const expected = Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== signature.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return mismatch === 0;
}

async function fetchStripeSubscription(subscriptionId: string, stripeKey: string): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(`https://api.stripe.com/v1/subscriptions/${subscriptionId}`, {
      headers: { Authorization: `Bearer ${stripeKey}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const webhookSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  if (!webhookSecret) {
    return jsonResponse({ error: "STRIPE_WEBHOOK_SECRET is not configured for this project yet." }, 501);
  }

  const signatureHeader = req.headers.get("Stripe-Signature");
  const rawBody = await req.text();

  if (!signatureHeader || !(await verifyStripeSignature(rawBody, signatureHeader, webhookSecret))) {
    return jsonResponse({ error: "Invalid signature" }, 400);
  }

  let event: Record<string, unknown>;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON payload" }, 400);
  }

  const admin = getSupabaseAdmin();
  const stripeKey = Deno.env.get("STRIPE_SECRET_KEY");

  // ---------------------------------------------------------------
  // One-time coin purchases AND initial subscription sync
  // ---------------------------------------------------------------
  if (event.type === "checkout.session.completed") {
    const session = ((event.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
    const metadata = (session.metadata ?? {}) as Record<string, unknown>;
    const profileId = metadata.profile_id as string | undefined;

    if (session.mode === "subscription") {
      // Best-effort quick sync so the account bar reflects the new
      // subscription right away — grant_subscription_period() (fired from
      // invoice.payment_succeeded below) is still the actual source of
      // truth for coins/perks, so it's fine if this branch is skipped or
      // races with it.
      if (profileId) {
        await admin
          .from("profiles")
          .update({
            stripe_customer_id: (session.customer as string) ?? null,
            stripe_subscription_id: (session.subscription as string) ?? null,
          })
          .eq("id", profileId);
      }
      return jsonResponse({ received: true });
    }

    // mode === "payment" — existing one-time Adventure Coins purchase flow.
    const coins = Number(metadata.coins);
    const paymentIntentId = (session.payment_intent as string) ?? (session.id as string) ?? null;

    if (!profileId || !Number.isFinite(coins) || coins <= 0) {
      return jsonResponse({ received: true, error: "Missing/invalid profile_id or coins in metadata" });
    }

    const { error } = await admin.rpc("credit_coins", {
      p_profile_id: profileId,
      p_amount: coins,
      p_reason: "purchase",
      p_stripe_payment_intent_id: paymentIntentId,
    });

    if (error) {
      if (error.code === "23505" || /duplicate key/i.test(error.message)) {
        return jsonResponse({ received: true, alreadyProcessed: true });
      }
      return jsonResponse({ error: error.message }, 500);
    }

    return jsonResponse({ received: true });
  }

  // ---------------------------------------------------------------
  // The actual monthly grant — first invoice AND every renewal
  // ---------------------------------------------------------------
  if (event.type === "invoice.payment_succeeded") {
    const invoice = ((event.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
    const subscriptionId = invoice.subscription as string | undefined;
    const invoiceId = invoice.id as string | undefined;

    if (!subscriptionId || !invoiceId) {
      // A one-off, non-subscription invoice — nothing for us to do.
      return jsonResponse({ received: true, ignored: true });
    }

    if (!stripeKey) {
      return jsonResponse({ error: "STRIPE_SECRET_KEY is not configured for this project yet." }, 501);
    }

    const subscription = await fetchStripeSubscription(subscriptionId, stripeKey);
    const subMetadata = (subscription?.metadata ?? {}) as Record<string, unknown>;
    const profileId = subMetadata.profile_id as string | undefined;
    const tier = subMetadata.tier as string | undefined;
    const plan = tier ? SUBSCRIPTION_PLANS[tier] : undefined;

    if (!profileId || !plan) {
      return jsonResponse({ received: true, error: "Missing/invalid profile_id or tier on subscription metadata" });
    }

    const periodEndUnix = subscription?.current_period_end as number | undefined;
    const periodEndIso = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null;

    // Keep stripe_customer_id/stripe_subscription_id in sync too, in case
    // the checkout.session.completed sync above never ran for this profile.
    await admin
      .from("profiles")
      .update({
        stripe_customer_id: (invoice.customer as string) ?? null,
        stripe_subscription_id: subscriptionId,
      })
      .eq("id", profileId);

    const { data: granted, error } = await admin.rpc("grant_subscription_period", {
      p_profile_id: profileId,
      p_tier: tier,
      p_stripe_invoice_id: invoiceId,
      p_coins: plan.coins,
      p_reroute_tokens: plan.rerouteTokens,
      p_reward_redemptions: plan.rewardRedemptions,
      p_period_end: periodEndIso,
    });

    if (error) {
      return jsonResponse({ error: error.message }, 500);
    }

    if (granted) {
      await admin.rpc("award_badge", { p_profile_id: profileId, p_badge_key: plan.badgeKey });
    }

    return jsonResponse({ received: true, granted: !!granted });
  }

  // ---------------------------------------------------------------
  // Subscription lifecycle — status changes and cancellations
  // ---------------------------------------------------------------
  if (event.type === "customer.subscription.updated") {
    const subscription = ((event.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
    const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
    const profileId = metadata.profile_id as string | undefined;
    const status = subscription.status as string | undefined;

    if (!profileId || !status) {
      return jsonResponse({ received: true, ignored: true });
    }

    if (status === "canceled" || status === "unpaid" || status === "incomplete_expired") {
      await admin.rpc("deactivate_subscription", { p_profile_id: profileId });
    } else if (status === "active" || status === "past_due" || status === "trialing") {
      // "trialing" and "active" both map to our 'active' status — this
      // project doesn't offer trials, but Stripe uses "trialing" for the
      // first period of some subscription configurations.
      await admin
        .from("profiles")
        .update({ subscription_status: status === "past_due" ? "past_due" : "active" })
        .eq("id", profileId);
    }

    return jsonResponse({ received: true });
  }

  if (event.type === "customer.subscription.deleted") {
    const subscription = ((event.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
    const metadata = (subscription.metadata ?? {}) as Record<string, unknown>;
    const profileId = metadata.profile_id as string | undefined;

    if (profileId) {
      await admin.rpc("deactivate_subscription", { p_profile_id: profileId });
    }

    return jsonResponse({ received: true });
  }

  // Not an event we care about — acknowledge so Stripe stops retrying it.
  return jsonResponse({ received: true, ignored: true });
});
