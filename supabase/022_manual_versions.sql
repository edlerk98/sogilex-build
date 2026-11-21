-- Hand-made website versions (Build's "Adjust photos"). Safe to re-run. Needs 008 and 021.
-- A manual version is saved straight from the page the person adjusted in Build: no AI, so it never counts toward a
-- plan's builds or changes (plan_used counts only 'build' and 'edit'). It becomes a normal version: Undo goes back to
-- its parent, it shows in "Your sites" and the account page, and it can be published.
alter table public.build_generations drop constraint if exists build_generations_kind_check;
alter table public.build_generations add constraint build_generations_kind_check
  check (kind = any (array['build', 'edit', 'import', 'caption', 'manual']));

create or replace function public.save_manual_version(p_parent uuid, p_html text, p_note text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  parent_html text;
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select o.html into parent_html from public.build_outputs o where o.build_id = p_parent and o.user_id = me;
  if parent_html is null then raise exception 'That site isn''t available to change. Open it again from Your sites.'; end if;
  if p_html is null or p_html !~* '<html' then raise exception 'That page couldn''t be saved.'; end if;
  if char_length(p_html) > 200000 then raise exception 'That page is too big to save.'; end if;
  -- Hand edits move photos; they never add code.
  if (char_length(lower(p_html)) - char_length(replace(lower(p_html), '<script', ''))) >
     (char_length(lower(parent_html)) - char_length(replace(lower(parent_html), '<script', ''))) then
    raise exception 'That page couldn''t be saved.';
  end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_manual_' || me::text));
  if (select count(*) from public.build_generations g
      where g.user_id = me and g.kind = 'manual' and g.created_at > now() - interval '24 hours') >= 200 then
    raise exception 'You''ve saved a lot of changes today. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id, kind, parent_id, note, status, finished_at)
  values (me, 'manual', p_parent, left(coalesce(nullif(btrim(p_note), ''), 'Adjusted by hand'), 200), 'done', now())
  returning id into new_id;
  insert into public.build_outputs (build_id, user_id, html) values (new_id, me, p_html);
  return new_id;
end $$;
revoke all on function public.save_manual_version(uuid, text, text) from public, anon;
grant execute on function public.save_manual_version(uuid, text, text) to authenticated;
