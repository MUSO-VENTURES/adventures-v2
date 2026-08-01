# MUSO Adventures — Backend (v1)

A real, deployable backend for the MUSO Adventures concept: routes/moods/twists,
QR check-ins, the leaderboard, the discovery form, and — the feature you asked
for specifically — **automatically letting the next stop's venue owner know
a group is on the way**, with headcount, ETA, and any game-related prep notes,
so they can save a table or get set up before players arrive.

## Why Supabase

You weren't sure on architecture, so here's the call and the reasoning: this
is built on **Supabase** (managed Postgres + Auth + Edge Functions), not a
hand-rolled Node server. Reasons:

- **You're building solo.** Supabase means no servers to patch, no separate
  auth system to write, and no ops rotation. A custom Node/Express API would
  need all of that built and maintained by you.
- **It scales the way you described** — "eventually millions of users."
  Postgres on Supabase scales vertically to very large instances and
  supports read replicas; Edge Functions are stateless and scale
  horizontally per-request automatically. You will not hit a ceiling at
  MVP-scale usage, and the migration path to a bigger Postgres instance
  later is a dashboard click, not a rewrite.
- **Row Level Security does your authorization for you.** Every table has
  policies (see `supabase/migrations/0001_init.sql`) so "a player can only
  see their own party's data" is enforced by Postgres itself, not by code
  that could have a bug.

If you later want a fully custom server (e.g. you hire a backend engineer
and want more control), the schema in `0001_init.sql` is plain Postgres and
will drop into any Postgres host — you're not locked in.

## What's included

```
supabase/
  migrations/
    0001_init.sql      -- full schema, indexes, leaderboard view, RLS policies
    0002_seed.sql       -- sample moods/twists/route/venues matching the landing page
  functions/
    checkin/            -- POST: record a QR check-in, notify the next venue
    leaderboard/         -- GET: ranked parties
    route-detail/         -- GET: a route's itinerary (mystery stops masked until check-in)
    discovery-submit/      -- POST: save the discovery form
    _shared/
      nextStopNotification.ts  -- pure logic for "who do we notify, and what do we say"
      notify.ts                -- Resend (email) + Twilio (SMS) senders
      supabaseAdmin.ts         -- service-role + user-scoped Supabase clients
      cors.ts
tests/
  nextStopNotification.test.js  -- unit tests for the notification logic (7 tests, all passing)
.env.example
```

## The venue heads-up feature, specifically

This is what you asked for on top of the MVP: when a group scans the QR code
and checks in at a stop, `checkin/index.ts` automatically:

1. Looks up the **next** stop on their route (by `stop_order`).
2. Finds that venue's primary contact in `venue_contacts`.
3. Sends them an email (or SMS, if that contact prefers it) with the party
   size, an ETA, and the stop's `game_prep_notes` — e.g. "ask for the MUSO
   lane booking" for an axe-throwing venue, or "reserve a private room" for
   karaoke.
4. Logs every attempt in `venue_notifications` (sent / failed / skipped —
   e.g. skipped if that venue hasn't given you a contact yet), so you can
   see delivery status without digging through email logs.

If there's no next stop (last stop of the route), no venue assigned yet
(mystery stop), or no contact on file, it just skips — the player's
check-in always succeeds regardless of whether the notification goes out.

**To use this for a real venue:** add a row to `venues`, then a row to
`venue_contacts` with their email (and `game_prep_notes` on the relevant
`route_stops` row if there's something specific they should prep). That's
it — no extra integration needed per venue.

## Deploying this for real

1. **Create a Supabase project** at supabase.com (free tier is enough to
   start; upgrade compute as usage grows).
2. **Install the CLI** and log in:
   ```
   npm install -g supabase
   supabase login
   supabase link --project-ref YOUR-PROJECT-REF
   ```
3. **Run the migrations:**
   ```
   supabase db push
   ```
   This creates all tables/policies from `0001_init.sql`. Then run
   `0002_seed.sql` from the Supabase SQL editor (or `psql`) to load sample
   data you can test against immediately.
4. **Get an email provider.** Sign up at resend.com (free tier covers
   early usage), verify your sending domain, and grab an API key.
5. **Set secrets** for the edge functions:
   ```
   supabase secrets set RESEND_API_KEY=... RESEND_FROM="MUSO Adventures <hello@yourdomain.com>"
   ```
   (SUPABASE_URL / SUPABASE_ANON_KEY / SUPABASE_SERVICE_ROLE_KEY are
   injected automatically for you inside deployed functions — you don't
   need to set those yourself.)
6. **Deploy the functions:**
   ```
   supabase functions deploy checkin
   supabase functions deploy leaderboard
   supabase functions deploy route-detail
   supabase functions deploy discovery-submit
   ```
7. **Point your frontend at it.** Each function gets a URL like
   `https://YOUR-PROJECT-REF.supabase.co/functions/v1/checkin`. Calls need
   an `Authorization: Bearer <user's access token>` header from Supabase
   Auth (email/magic-link/social login all work out of the box — set that
   up in Authentication > Providers in the dashboard).

Total cost to get live: Supabase free tier + a Resend free tier = **$0/month**
until you have real usage, then Supabase's paid tiers start around $25/mo
and scale with you.

## Testing what's here before you deploy

The notification logic (`_shared/nextStopNotification.ts`) is pure and unit
tested without touching a real database or sending real email:

```
npx tsc supabase/functions/_shared/nextStopNotification.ts \
  --target ES2020 --module commonjs --outDir /tmp/dist
LOGIC_MODULE=/tmp/dist/nextStopNotification.js node tests/nextStopNotification.test.js
```

All 7 cases pass: finding the next stop, picking the primary contact over a
non-primary one, falling back when nobody's marked primary, correctly *not*
notifying past the last stop or into an unassigned mystery stop, skipping
cleanly when a venue has no contact on file yet, and the actual email/SMS
copy that gets sent.

All edge functions also typecheck clean (`tsc --strict`, verified against a
Deno-shimmed config) — no `any`-typed footguns in the request handlers.

## What's *not* built yet (next steps, in priority order)

- **Rewards redemption flow** — `reward_tiers` and `reward_redemptions`
  tables exist and the leaderboard tracks `adventures_completed`, but
  there's no function yet that auto-grants a reward when a party crosses
  a milestone. Straightforward to add as a Postgres trigger or a small
  edge function once you're ready.
- **Recap strip generation** — stitching check-in photos into the
  photo-booth-style image shown on the landing page. This needs an image
  compositing step (e.g. via a library like `sharp` in a dedicated function,
  or a service like Cloudinary) that wasn't in scope for this pass.
- **Photo upload endpoint** — `check_ins.photo_url` exists in the schema,
  but there's no function yet handling the actual upload to Supabase
  Storage; right now the checkin function accepts a URL, assuming upload
  happens client-side directly to Storage first.
- **Venue self-service portal** — right now you'd add venues/contacts
  manually via the Supabase dashboard or SQL. A simple form for venues to
  manage their own contact info and `game_prep_notes` would remove that
  manual step as you sign up more partners.

None of these block launching the core game loop (browse a route, check in,
climb the leaderboard, notify the next stop) — they're the natural next
additions.
