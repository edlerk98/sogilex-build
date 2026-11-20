-- Sogilex Posts (beta): several saved social media posts per person, up to 100. Safe to re-run.
-- like menus, every word on a post is stored as typed inside data; no AI writes or changes it.
create table if not exists public.posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 200000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists posts_user_idx on public.posts (user_id, updated_at desc);
alter table public.posts enable row level security;
drop policy if exists "posts: read own" on public.posts;
drop policy if exists "posts: insert own" on public.posts;
drop policy if exists "posts: update own" on public.posts;
drop policy if exists "posts: delete own" on public.posts;
create policy "posts: read own" on public.posts for select to authenticated using (user_id = (select auth.uid()));
create policy "posts: insert own" on public.posts for insert to authenticated with check (user_id = (select auth.uid()));
create policy "posts: update own" on public.posts for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "posts: delete own" on public.posts for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.posts from anon, authenticated;
grant select, insert, update, delete on public.posts to authenticated;

-- At most 100 posts per person.
create or replace function public.posts_cap() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.posts f where f.user_id = new.user_id) >= 100 then
    raise exception 'You have 100 posts saved. Delete an old one to make a new one.';
  end if;
  return new;
end $$;
revoke all on function public.posts_cap() from public, anon, authenticated;
drop trigger if exists posts_cap on public.posts;
create trigger posts_cap before insert on public.posts for each row execute function public.posts_cap();

-- The service role isn't used here, but new tables in this project grant it nothing by default; keep it consistent.
grant select on public.posts to service_role;
