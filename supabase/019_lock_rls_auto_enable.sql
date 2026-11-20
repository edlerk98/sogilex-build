-- Safe to re-run. rls_auto_enable is the event trigger function behind "ensure_rls" (turns on row level security for
-- every new table in public). It can't be called directly anyway (event trigger functions only run as triggers), but
-- nobody but the owner needs EXECUTE on it, and the security advisor flags it. The trigger keeps working: triggers don't
-- check EXECUTE (checked 2026-11-20: a new table still got RLS).
revoke all on function public.rls_auto_enable() from public, anon, authenticated;
