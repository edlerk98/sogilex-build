-- Sogilex Build: chat edits. Each edit that changes the site is saved as a new version (a build_generations row
-- with kind = 'edit' and the version it came from in parent_id, plus its page in build_outputs), so "Your sites",
-- publishing and Undo work the same for edits as for builds. Edits have their own daily limits and don't use up
-- builds. Safe to re-run. Needs 003, 004 and 007.

alter table public.build_generations add column if not exists kind text not null default 'build';
alter table public.build_generations drop constraint if exists build_generations_kind_check;
alter table public.build_generations add constraint build_generations_kind_check check (kind in ('build', 'edit'));
alter table public.build_generations add column if not exists parent_id uuid references public.build_generations (id) on delete set null;
-- One line about what an edit changed (Claude's reply to the owner), shown in "Your sites".
alter table public.build_generations add column if not exists note text check (note is null or char_length(note) <= 200);

-- Builds: same rules as before, but only website builds count (edits have their own limits below).
create or replace function public.claim_build_slot()
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  per_person_per_day integer := 3;
  failed_per_day     constant integer := 5;
  everyone_per_day   constant integer := 50;
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select coalesce((select l.per_day from public.build_limits l where l.user_id = me), 3) into per_person_per_day;
  perform pg_advisory_xact_lock(hashtext('sogilex_build_slots'));
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'build' and status <> 'failed' and created_at > now() - interval '24 hours') >= per_person_per_day then
    raise exception 'You''ve used your % free builds for today. Try again tomorrow.', per_person_per_day;
  end if;
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'build' and status = 'failed' and created_at > now() - interval '24 hours') >= failed_per_day then
    raise exception 'Too many builds didn''t finish today. Please try again tomorrow.';
  end if;
  if (select count(*) from public.build_generations
      where kind = 'build' and created_at > now() - interval '24 hours') >= everyone_per_day then
    raise exception 'Sogilex Build has reached today''s limit. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id) values (me) returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.build_quota()
returns integer language sql stable security definer set search_path = '' as $$
  select greatest(0,
    coalesce((select l.per_day from public.build_limits l where l.user_id = auth.uid()), 3)
    - (select count(*)::integer from public.build_generations
        where user_id = auth.uid() and kind = 'build' and status <> 'failed' and created_at > now() - interval '24 hours'));
$$;

-- Reserve one edit of the signed-in person's own saved version, or refuse.
create or replace function public.claim_edit_slot(p_parent uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  per_person_per_day constant integer := 30;   -- edits per person per 24 hours (failed ones don't count)
  failed_per_day     constant integer := 10;
  everyone_per_day   constant integer := 500;  -- safety cap on total edit spend (~$0.03-0.10 each)
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if not exists (select 1 from public.build_outputs o where o.build_id = p_parent and o.user_id = me) then
    raise exception 'That site isn''t available to edit. Open it again from Your sites.';
  end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_edit_slots'));
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'edit' and status <> 'failed' and created_at > now() - interval '24 hours') >= per_person_per_day then
    raise exception 'You''ve used your % edits for today. Try again tomorrow.', per_person_per_day;
  end if;
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'edit' and status = 'failed' and created_at > now() - interval '24 hours') >= failed_per_day then
    raise exception 'Too many edits didn''t work today. Please try again tomorrow.';
  end if;
  if (select count(*) from public.build_generations
      where kind = 'edit' and created_at > now() - interval '24 hours') >= everyone_per_day then
    raise exception 'Editing has reached today''s limit. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id, kind, parent_id) values (me, 'edit', p_parent) returning id into new_id;
  return new_id;
end;
$$;

create or replace function public.edit_quota()
returns integer language sql stable security definer set search_path = '' as $$
  select greatest(0, 30 - (select count(*)::integer from public.build_generations
    where user_id = auth.uid() and kind = 'edit' and status <> 'failed' and created_at > now() - interval '24 hours'));
$$;

-- Only the edit-site Edge Function (service role) records how an edit ended.
create or replace function public.finish_edit(p_id uuid, ok boolean, in_tokens integer, out_tokens integer, stop text, p_note text)
returns void language sql security definer set search_path = '' as $$
  update public.build_generations
     set status = case when ok then 'done' else 'failed' end,
         input_tokens = in_tokens, output_tokens = out_tokens, finished_at = now(),
         stop_reason = left(stop, 40), note = left(p_note, 200)
   where id = p_id and kind = 'edit' and status = 'started';
$$;

-- Your sites, now with where each version came from.
drop function if exists public.my_builds();
create or replace function public.my_builds()
returns table (build_id uuid, created_at timestamptz, title text, kb integer, live boolean, kind text, parent_id uuid, note text)
language sql stable security definer set search_path = '' as $$
  select o.build_id,
         o.created_at,
         left(btrim(regexp_replace(coalesce(substring(o.html from '(?i)<title[^>]*>(.*?)</title>'), ''), '\s+', ' ', 'g')), 80),
         (octet_length(o.html) / 1024)::integer,
         exists (select 1 from public.sites x where x.user_id = o.user_id and x.build_id = o.build_id),
         g.kind, g.parent_id, g.note
  from public.build_outputs o
  join public.build_generations g on g.id = o.build_id
  where o.user_id = auth.uid()
  order by o.created_at desc
  limit 100;
$$;

revoke all on function public.claim_edit_slot(uuid) from public, anon;
revoke all on function public.edit_quota() from public, anon;
revoke all on function public.finish_edit(uuid, boolean, integer, integer, text, text) from public, anon, authenticated;
revoke all on function public.my_builds() from public, anon;
grant execute on function public.claim_edit_slot(uuid) to authenticated;
grant execute on function public.edit_quota() to authenticated;
grant execute on function public.finish_edit(uuid, boolean, integer, integer, text, text) to service_role;
grant execute on function public.my_builds() to authenticated;
