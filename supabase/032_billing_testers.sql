-- 032 (2026-11-24): the billing function (service role) reads app_settings 'billing_testers': while Stripe runs on a test
-- key, only those accounts (user ids, comma-separated) can check out, because test cards always "pay". Safe to re-run.
-- Tables in this project don't grant service_role by default (see PROGRESS.md), so without this every account counted
-- as "not a tester" (safe, but nobody could test).
grant select on public.app_settings to service_role;
-- The list starts empty. Add a tester (Table Editor -> app_settings, or SQL):
--   insert into public.app_settings (key, value) values ('billing_testers', '<user id>,<user id>')
--   on conflict (key) do update set value = excluded.value;
