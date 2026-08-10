// POST /party-social
// Body: { action: 'createInvite', partyId: string }
//     | { action: 'claimInvite', inviteCode: string }
//     | { action: 'partyRoster', partyId: string }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Backs the social party features: real QR-code invites (0027_social_party_
// invites.sql's party_invites table), joining a party by claiming one, and
// the roster panel (active members + pending invites) that renders from
// partyRoster. All mutations go through the admin (service-role) client —
// party_invites has no client insert/update RLS policy on purpose, since
// claiming an invite pays out a real coin bonus to the inviter and that
// logic must not be triggerable by a direct client write.

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

type Admin = ReturnType<typeof getSupabaseAdmin>;

async function isPartyMember(admin: Admin, partyId: string, userId: string): Promise<boolean> {
  const { data } = await admin
    .from("party_members")
    .select("profile_id")
    .eq("party_id", partyId)
    .eq("profile_id", userId)
    .maybeSingle();
  return !!data;
}

// One-time bonus paid to whoever created the invite, the moment it's
// claimed — scaled by how many people were already in the party when the
// invite was issued (snapshotted on party_invites.party_size_at_creation
// so a later size change can't retroactively change an already-issued
// invite's payout). Tune freely — this is a first pass, not tuned against
// real economy data yet.
const REFERRAL_BASE_COINS = 15;

async function buildRoster(admin: Admin, partyId: string) {
  const [{ data: members }, { data: pendingInvites }] = await Promise.all([
    admin
      .from("party_members")
      .select("profile_id, role, joined_at, profiles(display_name, avatar_url, level, xp)")
      .eq("party_id", partyId)
      .order("joined_at", { ascending: true }),
    admin
      .from("party_invites")
      .select("id, invite_code, created_by, created_at")
      .eq("party_id", partyId)
      .eq("status", "pending"),
  ]);

  const memberIds = (members ?? []).map((m) => m.profile_id);
  let badgeCounts = new Map<string, number>();
  if (memberIds.length) {
    const { data: badgeRows } = await admin
      .from("profile_badges")
      .select("profile_id")
      .in("profile_id", memberIds);
    for (const row of badgeRows ?? []) {
      badgeCounts.set(row.profile_id, (badgeCounts.get(row.profile_id) ?? 0) + 1);
    }
  }

  return {
    members: (members ?? []).map((m) => ({
      profileId: m.profile_id,
      role: m.role,
      joinedAt: m.joined_at,
      displayName: (m as any).profiles?.display_name ?? "Explorer",
      avatarUrl: (m as any).profiles?.avatar_url ?? null,
      level: (m as any).profiles?.level ?? 1,
      xp: (m as any).profiles?.xp ?? 0,
      badgeCount: badgeCounts.get(m.profile_id) ?? 0,
    })),
    pendingInvites: (pendingInvites ?? []).map((i) => ({
      id: i.id,
      inviteCode: i.invite_code,
      createdBy: i.created_by,
      createdAt: i.created_at,
    })),
  };
}

function randomInviteCode(): string {
  // Short, URL-safe, human-typeable if needed as a fallback to scanning.
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I ambiguity
  let code = "";
  for (let i = 0; i < 8; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const authHeader = req.headers.get("Authorization") ?? "";
  const jwt = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) {
    return jsonResponse({ error: "Sign in required." }, 401);
  }

  const admin = getSupabaseAdmin();
  const { data: userData, error: userErr } = await admin.auth.getUser(jwt);
  const userId = userData?.user?.id;
  if (userErr || !userId) {
    return jsonResponse({ error: "Your session has expired. Sign in again." }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action;

  if (action === "createInvite") {
    const partyId = typeof body.partyId === "string" ? body.partyId : null;
    if (!partyId) return jsonResponse({ error: "partyId is required" }, 400);
    if (!(await isPartyMember(admin, partyId, userId))) {
      return jsonResponse({ error: "You're not a member of that party." }, 403);
    }

    const { count: partySize } = await admin
      .from("party_members")
      .select("profile_id", { count: "exact", head: true })
      .eq("party_id", partyId);

    // adventure_id is best-effort context (which adventure this invite was
    // issued from), not load-bearing — a party can issue an invite before
    // any adventure has started.
    const { data: activeAdventure } = await admin
      .from("adventures")
      .select("id")
      .eq("party_id", partyId)
      .eq("status", "in_progress")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    const inviteCode = randomInviteCode();
    const { data: invite, error: inviteErr } = await admin
      .from("party_invites")
      .insert({
        party_id: partyId,
        adventure_id: activeAdventure?.id ?? null,
        created_by: userId,
        invite_code: inviteCode,
        party_size_at_creation: partySize ?? 1,
      })
      .select("invite_code")
      .single();
    if (inviteErr) return jsonResponse({ error: inviteErr.message }, 400);

    return jsonResponse({
      inviteCode: invite.invite_code,
      joinUrl: `https://musoadventures.com/preview/index.html?join=${invite.invite_code}`,
    });
  }

  if (action === "claimInvite") {
    const inviteCode = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : null;
    if (!inviteCode) return jsonResponse({ error: "inviteCode is required" }, 400);

    const { data: invite, error: inviteErr } = await admin
      .from("party_invites")
      .select("id, party_id, created_by, party_size_at_creation, status")
      .eq("invite_code", inviteCode)
      .maybeSingle();
    if (inviteErr) return jsonResponse({ error: inviteErr.message }, 400);
    if (!invite) return jsonResponse({ error: "That invite code wasn't found." }, 404);

    const alreadyMember = await isPartyMember(admin, invite.party_id, userId);

    if (invite.status !== "pending" && !alreadyMember) {
      return jsonResponse({ error: "That invite has already been used." }, 409);
    }

    if (!alreadyMember) {
      const { error: joinErr } = await admin
        .from("party_members")
        .insert({ party_id: invite.party_id, profile_id: userId, role: "member" });
      if (joinErr) return jsonResponse({ error: joinErr.message }, 400);

      await admin
        .from("party_invites")
        .update({ status: "claimed", claimed_by: userId, claimed_at: new Date().toISOString() })
        .eq("id", invite.id);

      // Referral bonus to the inviter — best-effort, same spirit as every
      // other coin credit in this codebase: a failure here shouldn't
      // unwind the join that already succeeded.
      if (invite.created_by !== userId) {
        const bonus = REFERRAL_BASE_COINS * Math.max(invite.party_size_at_creation ?? 1, 1);
        const { error: bonusErr } = await admin.rpc("credit_coins", {
          p_profile_id: invite.created_by,
          p_amount: bonus,
          p_reason: "referral_bonus",
          p_adventure_id: null,
        });
        if (bonusErr) console.error("referral_bonus credit failed:", bonusErr.message);
      }
    }

    const roster = await buildRoster(admin, invite.party_id);
    return jsonResponse({ partyId: invite.party_id, ...roster });
  }

  if (action === "partyRoster") {
    const partyId = typeof body.partyId === "string" ? body.partyId : null;
    if (!partyId) return jsonResponse({ error: "partyId is required" }, 400);
    if (!(await isPartyMember(admin, partyId, userId))) {
      return jsonResponse({ error: "You're not a member of that party." }, 403);
    }

    const roster = await buildRoster(admin, partyId);
    return jsonResponse({ partyId, ...roster });
  }

  return jsonResponse({ error: "action must be 'createInvite', 'claimInvite', or 'partyRoster'" }, 400);
});
