-- Sogilex Build: per-person daily limits for AI site generation.
-- Run once in Supabase: SQL Editor > New query > paste > Run. Safe to re-run.
-- To change the default limits, edit the numbers in claim_build_slot() and build_quota() and run this again.
-- To change one person's limit, use the build_limits table instead.

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

-- Per-person overrides: a higher daily build limit, and who may publish while publishing is in closed beta.
-- Nobody can read or change this through the API; only the functions below use it. Add a row in the dashboard
-- (Table Editor > build_limits) to raise someone's limit or let them publish.
create table if not exists public.build_limits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  per_day integer not null default 3 check (per_day between 0 and 100),
  can_publish boolean not null default false,
  note text
);
alter table public.build_limits enable row level security;
revoke all on public.build_limits from anon, authenticated;

-- Reserve one generation for the signed-in person, or refuse. Failed builds don't count toward the
-- 3 a day. Only the Edge Function (service role) can mark a build failed, so nobody can free up slots
-- by failing their own builds; failures are still capped at 5 a day and every build counts toward the 50.
create or replace function public.claim_build_slot()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  per_person_per_day integer := 3;             -- free builds per person per 24 hours, unless build_limits says otherwise (failed builds don't count)
  failed_per_day     constant integer := 5;    -- failed builds per person per 24 hours, so retries can't drain the shared cap
  everyone_per_day   constant integer := 50;   -- safety cap on total spend per 24 hours (~$0.25 each; counts every build)
  me uuid := auth.uid();
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select coalesce((select l.per_day from public.build_limits l where l.user_id = me), 3) into per_person_per_day;
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

-- Record how a build ended. Only once per build, and only the Edge Function can call it (service role):
-- if signed-in people could call it, they could mark their own builds failed to dodge the daily limit.
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
   where id = build_id and status = 'started';
$$;

-- How many builds the signed-in person has left today.
create or replace function public.build_quota()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select greatest(0,
    coalesce((select l.per_day from public.build_limits l where l.user_id = auth.uid()), 3)
    - (select count(*)::integer from public.build_generations
        where user_id = auth.uid() and status <> 'failed' and created_at > now() - interval '24 hours'));
$$;

revoke all on function public.claim_build_slot() from public, anon;
revoke all on function public.finish_build(uuid, boolean, integer, integer, text) from public, anon, authenticated;
revoke all on function public.build_quota() from public, anon;
grant execute on function public.claim_build_slot() to authenticated;
grant execute on function public.finish_build(uuid, boolean, integer, integer, text) to service_role;
grant execute on function public.build_quota() to authenticated;

-- Build times and cost, newest first:
-- select created_at, status, stop_reason, output_tokens,
--        round(extract(epoch from finished_at - created_at)) as seconds,
--        round((input_tokens * 4 + output_tokens * 20) / 1e6, 3) as usd
--   from public.build_generations order by created_at desc limit 20;
