-- MUSO Adventures — permanent personal invite codes (v28)
--
-- The invite flow built in 0027 generates a fresh, single-use code every
-- time someone taps "Show my QR," tied to whatever party/adventure is
-- active at that moment — good for "join my adventure right now," no good
-- for "here's my code, add me anytime" (the QR only exists while an
-- adventure is active). This adds a second, complementary code: one
-- permanent code per profile, generated lazily the first time it's
-- needed (at sign-in, or on-demand as a failsafe if that somehow didn't
-- happen), that always resolves to whatever party/adventure its owner is
-- currently active in at the moment it's scanned — see party-social's
-- claimInvite, which now checks party_invites first (the 0027 ephemeral
-- codes) and falls back to profiles.personal_invite_code.

alter table profiles
  add column if not exists personal_invite_code text unique;
