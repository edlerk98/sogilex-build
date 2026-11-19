-- Sogilex Menus: read a menu from photos (or a PDF). Each import is a build_generations row with kind 'import',
-- so it has its own daily limit and doesn't use up website builds or edits. The photos are not stored.
-- Safe to re-run. Needs 003 and 008.

alter table public.build_generations drop constraint if exists build_generations_kind_check;
alter table public.build_generations add constraint build_generations_kind_check check (kind in ('build', 'edit', 'import'));

create or replace function public.claim_import_slot()
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  per_person_per_day constant integer := 10;   -- menu imports per person per 24 hours (failed ones don't count)
  failed_per_day     constant integer := 10;
  everyone_per_day   constant integer := 200;  -- safety cap on total import spend (~$0.05-0.20 each)
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_import_slots'));
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'import' and status <> 'failed' and created_at > now() - interval '24 hours') >= per_person_per_day then
    raise exception 'You''ve read % menus from photos today. Try again tomorrow, or type the changes in.', per_person_per_day;
  end if;
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'import' and status = 'failed' and created_at > now() - interval '24 hours') >= failed_per_day then
    raise exception 'Too many menu photos couldn''t be read today. Please try again tomorrow.';
  end if;
  if (select count(*) from public.build_generations
      where kind = 'import' and created_at > now() - interval '24 hours') >= everyone_per_day then
    raise exception 'Reading menus from photos has reached today''s limit. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id, kind) values (me, 'import') returning id into new_id;
  return new_id;
end;
$$;

-- Only the read-menu Edge Function (service role) records how an import ended.
create or replace function public.finish_import(p_id uuid, ok boolean, in_tokens integer, out_tokens integer, stop text)
returns void language sql security definer set search_path = '' as $$
  update public.build_generations
     set status = case when ok then 'done' else 'failed' end,
         input_tokens = in_tokens, output_tokens = out_tokens, finished_at = now(), stop_reason = left(stop, 40)
   where id = p_id and kind = 'import' and status = 'started';
$$;

revoke all on function public.claim_import_slot() from public, anon;
revoke all on function public.finish_import(uuid, boolean, integer, integer, text) from public, anon, authenticated;
grant execute on function public.claim_import_slot() to authenticated;
grant execute on function public.finish_import(uuid, boolean, integer, integer, text) to service_role;
