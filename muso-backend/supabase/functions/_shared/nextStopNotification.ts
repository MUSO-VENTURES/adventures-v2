// Pure business logic for the "heads up, players are on their way" feature.
// Kept framework-free (no Deno/Supabase imports) so it can be unit tested
// with a plain Node test runner as well as executed inside the edge function.

export interface RouteStopRow {
  id: string;
  route_id: string;
  venue_id: string | null;
  stop_order: number;
  name: string;
  is_mystery: boolean;
  game_prep_notes: string | null;
}

export interface VenueContactRow {
  id: string;
  venue_id: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  notify_by: "email" | "sms" | "both";
  is_primary: boolean;
}

export interface NotificationPlan {
  shouldNotify: boolean;
  reason?: "no_next_stop" | "next_stop_has_no_venue" | "no_contact_on_file";
  nextStop?: RouteStopRow;
  contact?: VenueContactRow;
  etaMinutes: number;
}

const DEFAULT_ETA_MINUTES = 20;

/**
 * Given the full ordered list of stops on a route and the stop_order that
 * was just checked into, figure out whether there is a "next" stop, and if
 * so which venue contact (if any) should get a heads-up.
 */
export function planNextStopNotification(
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

  // Mystery stops with no assigned venue yet can't be notified.
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

export interface NotificationMessage {
  subject: string;
  body: string;
}

/**
 * Builds the actual message shown to the venue owner/manager. Kept separate
 * from the send step so both email and SMS paths reuse the same copy logic,
 * and so it's trivially testable without hitting a real mail provider.
 */
export function buildVenueNotificationMessage(params: {
  venueName: string;
  partySize: number;
  etaMinutes: number;
  gamePrepNotes: string | null;
  partyLabel: string; // e.g. "Jordan & Alex's party"
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
