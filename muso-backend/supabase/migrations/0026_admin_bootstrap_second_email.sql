-- MUSO Adventures — grant admin dashboard access to a second account
-- Shane wants to use smusseau.ventures@gmail.com for the admin dashboard
-- for now, alongside the original smusseau@gmail.com bootstrap in
-- 0025_admin_dashboard.sql. Safe to re-run — no-op if already admin, and
-- a no-op (not an error) if that email hasn't signed in / has no profile
-- row yet.

update profiles set is_admin = true
where id = (select id from auth.users where email = 'smusseau.ventures@gmail.com');
