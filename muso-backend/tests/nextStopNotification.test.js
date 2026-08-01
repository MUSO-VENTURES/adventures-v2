// Plain-Node test for the pure notification-planning logic. Run with:
//   npx tsc supabase/functions/_shared/nextStopNotification.ts --target ES2020 --module commonjs --outDir /tmp/dist
//   node tests/nextStopNotification.test.js  (after adjusting the require path below)
//
// See README "Testing the notification logic" for the one-liner that does both.

const assert = require("assert");
const { planNextStopNotification, buildVenueNotificationMessage } = require(process.env.LOGIC_MODULE || "../dist/nextStopNotification.js");

const stops = [
  { id: "s1", route_id: "r1", venue_id: "v1", stop_order: 1, name: "Axe Throwing", is_mystery: false, game_prep_notes: "Ask for MUSO lane booking" },
  { id: "s2", route_id: "r1", venue_id: "v2", stop_order: 2, name: "Noodle Spot", is_mystery: false, game_prep_notes: null },
  { id: "s3", route_id: "r1", venue_id: null, stop_order: 3, name: "Unknown Location", is_mystery: true, game_prep_notes: null },
  { id: "s4", route_id: "r1", venue_id: "v4", stop_order: 4, name: "Corner Store", is_mystery: false, game_prep_notes: null },
];

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`PASS: ${name}`);
  } catch (e) {
    console.error(`FAIL: ${name}`);
    console.error(e);
    process.exitCode = 1;
  }
}

check("finds the next stop and its primary contact", () => {
  const contacts = new Map([
    ["v2", [
      { id: "c1", venue_id: "v2", contact_name: "A", email: "a@example.com", phone: null, notify_by: "email", is_primary: false },
      { id: "c2", venue_id: "v2", contact_name: "B", email: "b@example.com", phone: null, notify_by: "email", is_primary: true },
    ]],
  ]);
  const plan = planNextStopNotification(stops, 1, contacts, 15);
  assert.strictEqual(plan.shouldNotify, true);
  assert.strictEqual(plan.nextStop.id, "s2");
  assert.strictEqual(plan.contact.id, "c2"); // primary contact chosen over non-primary
  assert.strictEqual(plan.etaMinutes, 15);
});

check("falls back to any contact when none is marked primary", () => {
  const contacts = new Map([
    ["v2", [{ id: "c1", venue_id: "v2", contact_name: "A", email: "a@example.com", phone: null, notify_by: "email", is_primary: false }]],
  ]);
  const plan = planNextStopNotification(stops, 1, contacts);
  assert.strictEqual(plan.shouldNotify, true);
  assert.strictEqual(plan.contact.id, "c1");
});

check("does not notify when the next stop is a mystery stop with no venue", () => {
  const plan = planNextStopNotification(stops, 2, new Map());
  assert.strictEqual(plan.shouldNotify, false);
  assert.strictEqual(plan.reason, "next_stop_has_no_venue");
  assert.strictEqual(plan.nextStop.id, "s3");
});

check("does not notify when the venue has no contact on file", () => {
  const plan = planNextStopNotification(stops, 3, new Map());
  assert.strictEqual(plan.shouldNotify, false);
  assert.strictEqual(plan.reason, "no_contact_on_file");
  assert.strictEqual(plan.nextStop.id, "s4");
});

check("does not notify after the last stop", () => {
  const plan = planNextStopNotification(stops, 4, new Map());
  assert.strictEqual(plan.shouldNotify, false);
  assert.strictEqual(plan.reason, "no_next_stop");
});

check("message copy includes party size, ETA, and game prep notes", () => {
  const msg = buildVenueNotificationMessage({
    venueName: "Riverside Axe House",
    partySize: 4,
    etaMinutes: 20,
    gamePrepNotes: "Ask for the MUSO lane booking",
    partyLabel: "Jordan & Alex's party",
  });
  assert.ok(msg.subject.includes("4"));
  assert.ok(msg.subject.includes("20 min"));
  assert.ok(msg.body.includes("Riverside Axe House"));
  assert.ok(msg.body.includes("Ask for the MUSO lane booking"));
  assert.ok(msg.body.includes("Jordan & Alex's party"));
});

check("message omits the prep-notes line when there are none", () => {
  const msg = buildVenueNotificationMessage({
    venueName: "Corner Store",
    partySize: 2,
    etaMinutes: 10,
    gamePrepNotes: null,
    partyLabel: "A group",
  });
  assert.ok(!msg.body.includes("Game-related prep"));
});

console.log(`\n${passed} test(s) passed.`);
