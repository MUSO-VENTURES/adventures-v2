// POST /checkin
// Body: { adventureId: string, routeStopId: string, photoUrl?: string, etaMinutesOverride?: number }
//
// Records a QR check-in for the current stop, and — this is the "let the
// next venue know we're coming" feature — looks up the next stop on the
// route, finds that venue's contact, and sends them a heads-up so they can
// save a table or prep anything game-related before the group arrives.
//
// The check-in write happens as the calling user (RLS enforced: you can
// only check in for your own party's adventure). The venue lookup + email
// send happens with the service-role client, since venue_contacts isn't
// something players should be able to read directly.
//
// v10 addition: every successful check-in also awards real xp and, where
// it applies, one or more badges (first-ever check-in, a level milestone,
// finishing the whole route) via award_xp()/award_badge() — the same
// SECURITY DEFINER functions from 0010_badges_and_adventures.sql that back
// every other coin/xp mutation in this schema. The response's `progress`
// field carries whatever's new so the client can show a celebration.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Inlined from ../_shared/cors.ts, ../_shared/supabaseAdmin.ts,
// ../_shared/nextStopNotification.ts and ../_shared/notify.ts — the
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

interface RouteStopRow {
  id: string;
  route_id: string;
  venue_id: string | null;
  stop_order: number;
  name: string;
  is_mystery: boolean;
  game_prep_notes: string | null;
}

interface VenueContactRow {
  id: string;
  venue_id: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  notify_by: "email" | "sms" | "both";
  is_primary: boolean;
}

interface NotificationPlan {
  shouldNotify: boolean;
  reason?: "no_next_stop" | "next_stop_has_no_venue" | "no_contact_on_file";
  nextStop?: RouteStopRow;
  contact?: VenueContactRow;
  etaMinutes: number;
}

const DEFAULT_ETA_MINUTES = 20;

function planNextStopNotification(
  allStops: RouteStopRow[],
  justCheckedInStopOrder: number,
  contactsByVenue: Map<string, VenueContactRow[]>,
  etaMinutes: number = DEFAULT_ETA_MINUTES,
): NotificationPlan {
  const sorted = [...allStops].sort((a, b) => a.stop_order - b.stop_order);
  const nextStop = sorted.find((s) => s.stop_order === justCheckedInStopOrder + 1);

  if (!nextStop) {
    return { shouldNotify: false, reason: "no_next_stop", etaMinutes };
  }

  if (!nextStop.venue_id) {
    return { shouldNotify: false, reason: "next_stop_has_no_venue", nextStop, etaMinutes };
  }

  const contacts = contactsByVenue.get(nextStop.venue_id) ?? [];
  const contact =
    contacts.find((c) => c.is_primary && (c.email || c.phone)) ??
    contacts.find((c) => c.email || c.phone);

  if (!contact) {
    return { shouldNotify: false, reason: "no_contact_on_file", nextStop, etaMinutes };
  }

  return { shouldNotify: true, nextStop, contact, etaMinutes };
}

interface NotificationMessage {
  subject: string;
  body: string;
}

function buildVenueNotificationMessage(params: {
  venueName: string;
  partySize: number;
  etaMinutes: number;
  gamePrepNotes: string | null;
  partyLabel: string;
}): NotificationMessage {
  const { venueName, partySize, etaMinutes, gamePrepNotes, partyLabel } = params;

  const subject = `MUSO Adventures: a group of ${partySize} is headed your way (~${etaMinutes} min)`;

  const lines = [
    `Hey ${venueName}!`,
    ``,
    `${partyLabel} just checked in at their previous stop on a MUSO Adventures route and you're next. Estimated arrival: about ${etaMinutes} minutes from now.`,
    ``,
    `Party size: ${partySize}`,
  ];

  if (gamePrepNotes) {
    lines.push(``, `Game-related prep for this stop: ${gamePrepNotes}`);
  }

  lines.push(
    ``,
    `No action needed unless you'd like to save them a table or get set up. Thanks for being a MUSO Adventures partner!`,
  );

  return { subject, body: lines.join("\n") };
}

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "MUSO Adventures <hello@musoadventures.com>";

const TWILIO_ACCOUNT_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_AUTH_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
const TWILIO_FROM_NUMBER = Deno.env.get("TWILIO_FROM_NUMBER");

async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  if (!RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not configured");
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [to],
      subject,
      text: body,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Resend API error (${res.status}): ${errText}`);
  }
}

async function sendSms(to: string, body: string): Promise<void> {
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error("Twilio env vars are not configured");
  }

  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`;
  const creds = btoa(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${creds}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      To: to,
      From: TWILIO_FROM_NUMBER,
      Body: body,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Twilio API error (${res.status}): ${errText}`);
  }
}

const CHECKIN_XP = 50;
// Must match CHECKIN_PHOTO_COINS in preview/index.html. The client has
// displayed "+20 coins" messaging for a check-in photo since the photo
// booth shipped, but nothing here ever actually credited it — this was a
// real gap, not intentional, found while wiring up per-adventure coin
// attribution (0018_adventure_attribution.sql adds 'photo_bonus' to the
// coin_transactions reason allow-list this now writes against).
const CHECKIN_PHOTO_COINS = 20;

type Badge = { key: string; name: string; description: string; emoji: string };
type Progress = {
  xpGained: number;
  coinsGained: number;
  oldLevel?: number;
  newLevel?: number;
  leveledUp: boolean;
  newBadges: Badge[];
};

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let payload: {
    adventureId?: string;
    routeStopId?: string;
    photoUrl?: string;
    etaMinutesOverride?: number;
  };

  try {
    payload = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const { adventureId, routeStopId, photoUrl, etaMinutesOverride } = payload;
  if (!adventureId || !routeStopId) {
    return jsonResponse({ error: "adventureId and routeStopId are required" }, 400);
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

  // 1. Insert the check-in as the user (RLS confirms they belong to this
  //    adventure's party). Duplicate check-ins are blocked by the unique
  //    constraint on (adventure_id, route_stop_id).
  const { data: checkIn, error: checkInErr } = await userClient
    .from("check_ins")
    .insert({
      adventure_id: adventureId,
      route_stop_id: routeStopId,
      checked_in_by: userId,
      photo_url: photoUrl ?? null,
    })
    .select()
    .single();

  if (checkInErr) {
    const alreadyCheckedIn = checkInErr.code === "23505"; // unique_violation
    return jsonResponse(
      { error: alreadyCheckedIn ? "Already checked in at this stop" : checkInErr.message },
      alreadyCheckedIn ? 409 : 400,
    );
  }

  // From here on, use the admin client — we need to read venue_contacts and
  // party/route info that a player shouldn't have direct table access to.
  const admin = getSupabaseAdmin();

  // 2. Progress: xp for checking in, plus whatever badges this check-in
  //    just earned. This runs regardless of how the venue-notification step
  //    below goes — checking in is the player-facing win, the notification
  //    email is a side effect and shouldn't gate it.
  const [{ count: totalCheckins }, xpResultRes, coinsResultRes] = await Promise.all([
    admin.from("check_ins").select("id", { count: "exact", head: true }).eq("checked_in_by", userId),
    admin.rpc("award_xp", { p_profile_id: userId, p_amount: CHECKIN_XP }),
    photoUrl
      ? admin.rpc("credit_coins", {
          p_profile_id: userId,
          p_amount: CHECKIN_PHOTO_COINS,
          p_reason: "photo_bonus",
          p_adventure_id: adventureId,
        })
      : Promise.resolve({ data: null, error: null }),
  ]);

  const xpResult = (xpResultRes.data ?? {}) as {
    oldLevel?: number;
    newLevel?: number;
    leveledUp?: boolean;
  };
  // Best-effort — an odd coin-credit failure shouldn't fail the check-in
  // itself, it just means this particular photo bonus didn't land.
  const coinsGained = photoUrl && !coinsResultRes?.error ? CHECKIN_PHOTO_COINS : 0;
  const isFirstCheckin = (totalCheckins ?? 0) === 1;

  const badgeKeysToAward: string[] = [];
  if (isFirstCheckin) badgeKeysToAward.push("first_checkin");
  if (xpResult.leveledUp && (xpResult.newLevel ?? 0) >= 5) badgeKeysToAward.push("level_5");
  if (xpResult.leveledUp && (xpResult.newLevel ?? 0) >= 10) badgeKeysToAward.push("level_10");

  const { data: currentStop, error: stopErr } = await admin
    .from("route_stops")
    .select("id, route_id, venue_id, stop_order, name, is_mystery, game_prep_notes")
    .eq("id", routeStopId)
    .single();

  // If this check-in just finished every stop on the route, mark the
  // adventure completed and award the route-complete badge.
  if (!stopErr && currentStop) {
    const [{ count: stopCount }, { count: doneCount }] = await Promise.all([
      admin.from("route_stops").select("id", { count: "exact", head: true }).eq("route_id", currentStop.route_id),
      admin.from("check_ins").select("id", { count: "exact", head: true }).eq("adventure_id", adventureId),
    ]);

    if ((stopCount ?? 0) > 0 && (doneCount ?? 0) >= (stopCount ?? 0)) {
      badgeKeysToAward.push("adventure_completed");
      await admin
        .from("adventures")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("id", adventureId);
    }
  }

  const newBadges: Badge[] = [];
  for (const key of badgeKeysToAward) {
    const { data: awardedNew } = await admin.rpc("award_badge", {
      p_profile_id: userId,
      p_badge_key: key,
      p_meta: {},
      p_adventure_id: adventureId,
    });
    if (awardedNew) {
      const { data: badgeRow } = await admin
        .from("badges")
        .select("key, name, description, emoji")
        .eq("key", key)
        .single();
      if (badgeRow) newBadges.push(badgeRow as Badge);
    }
  }

  const progress: Progress = {
    xpGained: CHECKIN_XP,
    coinsGained,
    oldLevel: xpResult.oldLevel,
    newLevel: xpResult.newLevel,
    leveledUp: !!xpResult.leveledUp,
    newBadges,
  };

  if (stopErr || !currentStop) {
    // The check-in itself succeeded; the notification step is best-effort.
    return jsonResponse({ checkIn, progress, notification: { shouldNotify: false, reason: "stop_not_found" } });
  }

  const { data: adventure } = await admin
    .from("adventures")
    .select("id, party_id, parties(name)")
    .eq("id", adventureId)
    .single();

  const { data: allStops } = await admin
    .from("route_stops")
    .select("id, route_id, venue_id, stop_order, name, is_mystery, game_prep_notes")
    .eq("route_id", currentStop.route_id);

  const { data: partySizeRows } = await admin
    .from("party_members")
    .select("profile_id", { count: "exact" })
    .eq("party_id", adventure?.party_id);

  const partySize = partySizeRows?.length ?? 2;

  const stops = (allStops ?? []) as RouteStopRow[];
  const nextStopCandidate = stops.find((s) => s.stop_order === currentStop.stop_order + 1);

  let contactsByVenue = new Map<string, VenueContactRow[]>();
  if (nextStopCandidate?.venue_id) {
    const { data: contacts } = await admin
      .from("venue_contacts")
      .select("id, venue_id, contact_name, email, phone, notify_by, is_primary")
      .eq("venue_id", nextStopCandidate.venue_id);
    contactsByVenue = new Map([[nextStopCandidate.venue_id, (contacts ?? []) as VenueContactRow[]]]);
  }

  const plan = planNextStopNotification(
    stops,
    currentStop.stop_order,
    contactsByVenue,
    etaMinutesOverride,
  );

  if (!plan.shouldNotify || !plan.nextStop || !plan.contact) {
    if (plan.nextStop) {
      // Log the skip so it's visible why no email went out (e.g. venue has
      // no contact on file yet).
      await admin.from("venue_notifications").insert({
        adventure_id: adventureId,
        route_stop_id: plan.nextStop.id,
        channel: "email",
        party_size: partySize,
        eta_minutes: plan.etaMinutes,
        game_prep_notes: plan.nextStop.game_prep_notes,
        status: "skipped_no_contact",
      });
    }
    return jsonResponse({ checkIn, progress, notification: { shouldNotify: false, reason: plan.reason } });
  }

  const { data: venue } = await admin
    .from("venues")
    .select("name")
    .eq("id", plan.nextStop.venue_id!)
    .single();

  const message = buildVenueNotificationMessage({
    venueName: venue?.name ?? plan.nextStop.name,
    partySize,
    etaMinutes: plan.etaMinutes,
    gamePrepNotes: plan.nextStop.game_prep_notes,
    partyLabel: `${(adventure as any)?.parties?.name ?? "A MUSO Adventures group"}`,
  });

  const channel: "email" | "sms" =
    plan.contact.notify_by === "sms" ? "sms" : "email";

  const { data: logRow } = await admin
    .from("venue_notifications")
    .insert({
      adventure_id: adventureId,
      route_stop_id: plan.nextStop.id,
      venue_contact_id: plan.contact.id,
      channel,
      party_size: partySize,
      eta_minutes: plan.etaMinutes,
      game_prep_notes: plan.nextStop.game_prep_notes,
      status: "pending",
    })
    .select()
    .single();

  try {
    if (channel === "sms" && plan.contact.phone) {
      await sendSms(plan.contact.phone, `${message.subject}\n\n${message.body}`);
    } else if (plan.contact.email) {
      await sendEmail(plan.contact.email, message.subject, message.body);
    } else {
      throw new Error("Contact has no usable email/phone for the selected channel");
    }

    await admin
      .from("venue_notifications")
      .update({ status: "sent", sent_at: new Date().toISOString() })
      .eq("id", logRow?.id);

    return jsonResponse({
      checkIn,
      progress,
      notification: { shouldNotify: true, sentTo: venue?.name, channel },
    });
  } catch (sendErr) {
    await admin
      .from("venue_notifications")
      .update({ status: "failed", error: (sendErr as Error).message })
      .eq("id", logRow?.id);

    // Check-in still succeeds even if the notification failed — that's a
    // secondary feature and shouldn't block the player's progress.
    return jsonResponse({
      checkIn,
      progress,
      notification: { shouldNotify: true, sent: false, error: (sendErr as Error).message },
    });
  }
});
