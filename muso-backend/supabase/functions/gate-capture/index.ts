// POST /gate-capture
// Body: { birthDate: 'YYYY-MM-DD', email?: string, disclaimerAccepted: true }
//
// Fired once when a visitor passes the site entry gate (birthday +
// disclaimer). Stores the birthday (and optional email) in gate_signups so
// it can be used for birthday-special promotions later, and returns the
// computed age so the client can gate 21+ content rating options.
//
// This is deliberately separate from discovery-submit: the gate happens
// before anyone has necessarily filled out a discovery form, so it needs
// its own lightweight endpoint. Best-effort from the client's point of
// view — a failed call here should never block someone from entering the
// site, only from having their birthday remembered for promos.

import { handleOptions, jsonResponse } from "../_shared/cors.ts";
import { getSupabaseAdmin } from "../_shared/supabaseAdmin.ts";

const BIRTH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Same logic as discovery-submit's calculateAge — kept in sync intentionally
// rather than shared, since these are two small, independent endpoints.
function calculateAge(birthDateStr: string): number | null {
  if (!BIRTH_DATE_RE.test(birthDateStr)) return null;
  const birthDate = new Date(`${birthDateStr}T00:00:00Z`);
  if (Number.isNaN(birthDate.getTime())) return null;

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (birthDate.getTime() > today.getTime()) return null; // future date

  let age = today.getUTCFullYear() - birthDate.getUTCFullYear();
  const monthDiff = today.getUTCMonth() - birthDate.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getUTCDate() < birthDate.getUTCDate())) {
    age--;
  }
  return age >= 0 && age <= 120 ? age : null;
}

Deno.serve(async (req) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  const disclaimerAccepted = body.disclaimerAccepted === true;
  if (!disclaimerAccepted) {
    return jsonResponse({ error: "disclaimerAccepted must be true." }, 400);
  }

  const birthDateRaw = typeof body.birthDate === "string" ? body.birthDate : null;
  const age = birthDateRaw ? calculateAge(birthDateRaw) : null;
  if (!birthDateRaw || age === null) {
    return jsonResponse({ error: "Please provide a valid birth date." }, 400);
  }

  let email: string | null = null;
  if (typeof body.email === "string" && body.email.trim()) {
    const trimmed = body.email.trim();
    if (!EMAIL_RE.test(trimmed)) {
      return jsonResponse({ error: "Invalid email address." }, 400);
    }
    email = trimmed;
  }

  const admin = getSupabaseAdmin();
  const { error } = await admin.from("gate_signups").insert({
    birth_date: birthDateRaw,
    email,
    disclaimer_accepted: disclaimerAccepted,
    disclaimer_accepted_at: new Date().toISOString(),
  });

  if (error) {
    return jsonResponse({ error: error.message }, 400);
  }

  return jsonResponse({ ok: true, age, ageConfirmed: age >= 21 }, 201);
});
