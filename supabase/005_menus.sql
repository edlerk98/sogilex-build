-- Sogilex Menus (applied 2026-11-18): one saved menu per person. Safe to re-run.
-- Prices are stored as text inside data, exactly as typed.
create table if not exists public.menus (
  user_id uuid primary key references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 200000),
  updated_at timestamptz not null default now()
);
alter table public.menus enable row level security;
drop policy if exists "menus: read own" on public.menus;
drop policy if exists "menus: insert own" on public.menus;
drop policy if exists "menus: update own" on public.menus;
drop policy if exists "menus: delete own" on public.menus;
create policy "menus: read own" on public.menus for select to authenticated using (user_id = (select auth.uid()));
create policy "menus: insert own" on public.menus for insert to authenticated with check (user_id = (select auth.uid()));
create policy "menus: update own" on public.menus for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "menus: delete own" on public.menus for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.menus from anon, authenticated;
grant select, insert, update, delete on public.menus to authenticated;
