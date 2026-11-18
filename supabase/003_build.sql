-- Sogilex Build: per-person daily limits for AI site generation.
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.
-- To change the limits, edit the two numbers in claim_build_slot() and run this again.

create table if not exists public.build_generations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  status text not null default 'started' check (status in ('started', 'done', 'failed')),
  input_tokens integer,
  output_tokens integer
);
-- Added later: when the build ended and why (end_turn, max_tokens, refusal, error). Safe to re-run.
alter table public.build_generations add column if not exists finished_at timestamptz;
alter table public.build_generations add column if not exists stop_reason text;
create index if not exists build_generations_user_time on public.build_generations (user_id, created_at);
create index if not exists build_generations_time on public.build_generations (created_at);

alter table public.build_generations enable row level security;

drop policy if exists "builds: read own" on public.build_generations;
create policy "builds: read own" on public.build_generations
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.build_generations to authenticated;
revoke all on public.build_generations from anon;

-- Reserve one generation for the signed-in person, or refuse. Every reserved slot counts,
-- including failed ones, so nobody can free up slots by marking their own builds failed.
create or replace function public.claim_build_slot()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  per_person_per_day constant integer := 3;    -- free builds per person per 24 hours (failed builds don't count)
  failed_per_day     constant integer := 5;    -- failed builds per person per 24 hours, so retries can't drain the shared cap
  everyone_per_day   constant integer := 50;   -- safety cap on total spend per 24 hours (~$0.25 each; counts every build)
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_build_slots'));
  if (select count(*) from public.build_generations
      where user_id = me and status <> 'failed' and created_at > now() - interval '24 hours') >= per_person_per_day then
    raise exception 'You''ve used your % free builds for today. Try again tomorrow.', per_person_per_day;
  end if;
  if (select count(*) from public.build_generations
      where user_id = me and status = 'failed' and created_at > now() - interval '24 hours') >= failed_per_day then
    raise exception 'Too many builds didn''t finish today. Please try again tomorrow.';
  end if;
  if (select count(*) from public.build_generations
      where created_at > now() - interval '24 hours') >= everyone_per_day then
    raise exception 'Sogilex Build has reached today''s limit. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id) values (me) returning id into new_id;
  return new_id;
end;
$$;

-- Record how a build ended (for your own cost tracking). Only the owner's own row, only once.
-- The old four-argument version is replaced by the one below (stop_reason defaults to null, so an
-- un-redeployed function that still sends four arguments keeps working).
drop function if exists public.finish_build(uuid, boolean, integer, integer);
create or replace function public.finish_build(build_id uuid, ok boolean, in_tokens integer, out_tokens integer,
                                               stop text default null)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.build_generations
     set status = case when ok then 'done' else 'failed' end,
         input_tokens = in_tokens,
         output_tokens = out_tokens,
         finished_at = now(),
         stop_reason = left(stop, 40)
   where id = build_id and user_id = auth.uid() and status = 'started';
$$;

-- How many builds the signed-in person has left today.
create or replace function public.build_quota()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0, 3 - (select count(*)::integer from public.build_generations
                          where user_id = auth.uid() and status <> 'failed'
                            and created_at > now() - interval '24 hours'));
$$;

revoke all on function public.claim_build_slot() from public, anon;
revoke all on function public.finish_build(uuid, boolean, integer, integer, text) from public, anon;
revoke all on function public.build_quota() from public, anon;
grant execute on function public.claim_build_slot() to authenticated;
grant execute on function public.finish_build(uuid, boolean, integer, integer, text) to authenticated;
grant execute on function public.build_quota() to authenticated;

-- Build times and cost, newest first:
-- select created_at, status, stop_reason, output_tokens,
--        round(extract(epoch from finished_at - created_at)) as seconds,
--        round((input_tokens * 4 + output_tokens * 20) / 1e6, 3) as usd
--   from public.build_generations order by created_at desc limit 20;
