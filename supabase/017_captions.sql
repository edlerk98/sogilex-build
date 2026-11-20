-- Sogilex Posts: AI-written captions (Edge Function write-caption). Safe to re-run. Needs 003 (build_generations).
-- Each caption written or changed is one row in build_generations with kind 'caption', so it shares the same
-- usage log and token counts as builds, edits and menu reading. Limits: 40 a person a day (failed ones don't
-- count, at most 10 failures), 1000 a day for everyone.
alter table public.build_generations drop constraint if exists build_generations_kind_check;
alter table public.build_generations add constraint build_generations_kind_check check (kind = any (array['build', 'edit', 'import', 'caption']));

create or replace function public.claim_caption_slot() returns uuid language plpgsql security definer set search_path = '' as $$
declare
  per_person_per_day constant integer := 40;
  failed_per_day     constant integer := 10;
  everyone_per_day   constant integer := 1000;
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_caption_slots'));
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'caption' and status <> 'failed' and created_at > now() - interval '24 hours') >= per_person_per_day then
    raise exception 'You''ve written % captions today. Try again tomorrow, or edit the caption by hand.', per_person_per_day;
  end if;
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'caption' and status = 'failed' and created_at > now() - interval '24 hours') >= failed_per_day then
    raise exception 'Too many captions didn''t work today. Please try again tomorrow.';
  end if;
  if (select count(*) from public.build_generations where kind = 'caption' and created_at > now() - interval '24 hours') >= everyone_per_day then
    raise exception 'Caption writing has reached today''s limit. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id, kind) values (me, 'caption') returning id into new_id;
  return new_id;
end $$;

create or replace function public.caption_quota() returns integer language sql stable security definer set search_path = '' as $$
  select greatest(0, 40 - (select count(*)::integer from public.build_generations
    where user_id = auth.uid() and kind = 'caption' and status <> 'failed' and created_at > now() - interval '24 hours'));
$$;

create or replace function public.finish_caption(p_id uuid, ok boolean, in_tokens integer, out_tokens integer, stop text)
returns void language sql security definer set search_path = '' as $$
  update public.build_generations
     set status = case when ok then 'done' else 'failed' end,
         input_tokens = in_tokens, output_tokens = out_tokens, finished_at = now(), stop_reason = left(stop, 40)
   where id = p_id and kind = 'caption' and status = 'started';
$$;

revoke all on function public.claim_caption_slot() from public, anon;
revoke all on function public.caption_quota() from public, anon;
revoke all on function public.finish_caption(uuid, boolean, integer, integer, text) from public, anon, authenticated;
grant execute on function public.claim_caption_slot() to authenticated;
grant execute on function public.caption_quota() to authenticated;
grant execute on function public.finish_caption(uuid, boolean, integer, integer, text) to service_role;
