-- Delete one saved website version from "Your account". Safe to re-run.
-- Removes the saved page (build_outputs) only. The build_generations row stays, because it is the usage record the
-- daily build/edit limits count; without its page it no longer shows in "Your sites" or the account page.
-- The published version can't be deleted (unpublish it in Build first).
create or replace function public.delete_my_build(p_id uuid) returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if exists (select 1 from public.sites s where s.user_id = me and s.build_id = p_id) then
    raise exception 'This version is your published site. Unpublish it in Build before deleting it.';
  end if;
  delete from public.build_outputs o where o.build_id = p_id and o.user_id = me;
  if not found then raise exception 'That version wasn''t found.'; end if;
end $$;
revoke all on function public.delete_my_build(uuid) from public, anon;
grant execute on function public.delete_my_build(uuid) to authenticated;
