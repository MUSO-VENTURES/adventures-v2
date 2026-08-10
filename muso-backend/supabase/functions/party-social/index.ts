// POST /party-social
// Body: { action: 'createInvite', partyId: string }
//     | { action: 'claimInvite', inviteCode: string }
//     | { action: 'partyRoster', partyId: string }
//     | { action: 'getMyPersonalCode' }
// Requires Authorization: Bearer <user JWT> (Supabase Auth).
//
// Backs the social party features: real QR-code invites (0027_social_party_
// invites.sql's party_invites table), a permanent per-player code
// (0028_personal_invite_codes.sql's profiles.personal_invite_code) for
// "add me anytime" rather than "join my adventure right now," joining a
// party by claiming either kind, and the roster panel (active members +
// pending invites) that renders from partyRoster. All party_invites
// mutations go through the admin (service-role) client — that table has
// no client insert/update RLS policy on purpose, since claiming an invite
// pays out a real coin bonus to the inviter and that logic must not be
// triggerable by a direct client write.

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
    const rawCode = typeof body.inviteCode === "string" ? body.inviteCode.trim().toUpperCase() : null;
    if (!rawCode) return jsonResponse({ error: "inviteCode is required" }, 400);

    // Two kinds of code share the same format: a one-time
    // party_invites.invite_code (tied to one specific party at the moment
    // it was created, shows a "pending" slot in the roster until claimed)
    // and a permanent profiles.personal_invite_code (0028_personal_invite_
    // codes.sql — always resolves to whichever party its owner is
    // currently active in, since it's reused indefinitely rather than
    // minted per-invite). Try the one-time kind first since it's the more
    // specific, intentional invite when both happen to exist.
    const { data: invite } = await admin
      .from("party_invites")
      .select("id, party_id, created_by, party_size_at_creation, status")
      .eq("invite_code", rawCode)
      .maybeSingle();

    let partyId: string;
    let inviterId: string;
    let referralPartySize: number;
    let inviteRowId: string | null = null;

    if (invite) {
      if (invite.status !== "pending" && !(await isPartyMember(admin, invite.party_id, userId))) {
        return jsonResponse({ error: "That invite has already been used." }, 409);
      }
      partyId = invite.party_id;
      inviterId = invite.created_by;
      referralPartySize = invite.party_size_at_creation ?? 1;
      inviteRowId = invite.id;
    } else {
      const { data: owner } = await admin
        .from("profiles")
        .select("id, display_name")
        .eq("personal_invite_code", rawCode)
        .maybeSingle();
      if (!owner) return jsonResponse({ error: "That invite code wasn't found." }, 404);

      // A personal code should work at ANY point, not only mid-adventure —
      // "gather your group first, then start together" is exactly the
      // scenario this exists for. Prefer the owner's party with a
      // currently in-progress adventure if there is one (so a mid-
      // adventure scan still drops the scanner straight into it, same as
      // before); otherwise fall back to any existing party of theirs; and
      // if they don't have one at all yet, create one now — mirroring
      // real-venue-adventure/index.ts's ensureParty action, since this is
      // effectively the same "first party, lazily created" bootstrap.
      const { data: memberRows } = await admin
        .from("party_members")
        .select("party_id")
        .eq("profile_id", owner.id);
      const partyIds = (memberRows ?? []).map((r) => r.party_id);
      let resolvedPartyId: string | null = null;
      if (partyIds.length) {
        const { data: advRows } = await admin
          .from("adventures")
          .select("party_id")
          .in("party_id", partyIds)
          .eq("status", "in_progress")
          .order("started_at", { ascending: false })
          .limit(1);
        resolvedPartyId = advRows?.[0]?.party_id ?? partyIds[0];
      }
      if (!resolvedPartyId) {
        const { data: newParty, error: newPartyErr } = await admin
          .from("parties")
          .insert({ name: `${owner.display_name || "Explorer"}'s Crew`, created_by: owner.id })
          .select("id")
          .single();
        if (newPartyErr) return jsonResponse({ error: newPartyErr.message }, 400);
        resolvedPartyId = newParty.id;
        const { error: ownerJoinErr } = await admin
          .from("party_members")
          .insert({ party_id: resolvedPartyId, profile_id: owner.id, role: "owner" });
        if (ownerJoinErr) return jsonResponse({ error: ownerJoinErr.message }, 400);
      }

      const { count: currentPartySize } = await admin
        .from("party_members")
        .select("profile_id", { count: "exact", head: true })
        .eq("party_id", resolvedPartyId);
      partyId = resolvedPartyId;
      inviterId = owner.id;
      referralPartySize = currentPartySize ?? 1;
    }

    const alreadyMember = await isPartyMember(admin, partyId, userId);

    if (!alreadyMember) {
      const { error: joinErr } = await admin
        .from("party_members")
        .insert({ party_id: partyId, profile_id: userId, role: "member" });
      if (joinErr) return jsonResponse({ error: joinErr.message }, 400);

      if (inviteRowId) {
        await admin
          .from("party_invites")
          .update({ status: "claimed", claimed_by: userId, claimed_at: new Date().toISOString() })
          .eq("id", inviteRowId);
      }

      // Referral bonus to the inviter — best-effort, same spirit as every
      // other coin credit in this codebase: a failure here shouldn't
      // unwind the join that already succeeded.
      if (inviterId !== userId) {
        const bonus = REFERRAL_BASE_COINS * Math.max(referralPartySize, 1);
        const { error: bonusErr } = await admin.rpc("credit_coins", {
          p_profile_id: inviterId,
          p_amount: bonus,
          p_reason: "referral_bonus",
          p_adventure_id: null,
        });
        if (bonusErr) console.error("referral_bonus credit failed:", bonusErr.message);
      }
    }

    const roster = await buildRoster(admin, partyId);
    return jsonResponse({ partyId, ...roster });
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

  if (action === "getMyPersonalCode") {
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("personal_invite_code")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr) return jsonResponse({ error: profileErr.message }, 400);

    let code = profile?.personal_invite_code ?? null;
    if (!code) {
      // Lazily generated the first time it's needed — called once right
      // after sign-in from preview/index.html, and callable again anytime
      // as a failsafe (e.g. an account created before this existed). The
      // .is(...,null) guard means a rare concurrent double-call can't both
      // "win" with different codes — only one update actually applies, and
      // both requests re-read whatever ends up there afterward.
      const candidate = randomInviteCode();
      await admin
        .from("profiles")
        .update({ personal_invite_code: candidate })
        .eq("id", userId)
        .is("personal_invite_code", null);
      const { data: refetched } = await admin
        .from("profiles")
        .select("personal_invite_code")
        .eq("id", userId)
        .maybeSingle();
      code = refetched?.personal_invite_code ?? null;
      if (!code) return jsonResponse({ error: "Could not generate a code right now. Try again." }, 500);
    }

    return jsonResponse({
      inviteCode: code,
      joinUrl: `https://musoadventures.com/preview/index.html?join=${code}`,
    });
  }

  return jsonResponse({ error: "action must be 'createInvite', 'claimInvite', 'partyRoster', or 'getMyPersonalCode'" }, 400);
});
