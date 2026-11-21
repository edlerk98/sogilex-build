-- Security review tidy-up (2026-11-21). Safe to re-run.
-- 1. Signed-in users had TRUNCATE / TRIGGER / REFERENCES on build_generations (from an old default). The API can't use
--    them, but nobody should have them. They keep SELECT (their own rows, by RLS).
revoke truncate, trigger, references on public.build_generations from anon, authenticated;
-- 2. delete_my_account() only deleted the login (rows cascade) and left photos in storage and a published site online
--    with no owner. Nothing calls it; account deletion is by email until a complete version exists.
revoke all on function public.delete_my_account() from public, anon, authenticated;
