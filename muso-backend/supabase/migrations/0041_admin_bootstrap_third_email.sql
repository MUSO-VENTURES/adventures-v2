-- MUSO Adventures — grant admin/test access to a third account
-- Shane wants smusseau.jobs@gmail.com to be able to virtual check-in
-- (checkin/index.ts's "virtual" verifyMethod, gated on is_admin) so he can
-- test multi-party flows across three of his own accounts without
-- physically visiting venues. Same bootstrap pattern as 0025/0026. Safe to
-- re-run — no-op if already admin, and a no-op (not an error) if that
-- email hasn't signed in / has no profile row yet.

update profiles set is_admin = true
where id = (select id from auth.users where email = 'smusseau.jobs@gmail.com');
