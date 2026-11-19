-- Sogilex Flyers (beta): several saved flyers per person, up to 40. Safe to re-run.
-- Like menus, every word on a flyer is stored as typed inside data; no AI writes or changes it.
create table if not exists public.flyers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 200000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists flyers_user_idx on public.flyers (user_id, updated_at desc);
alter table public.flyers enable row level security;
drop policy if exists "flyers: read own" on public.flyers;
drop policy if exists "flyers: insert own" on public.flyers;
drop policy if exists "flyers: update own" on public.flyers;
drop policy if exists "flyers: delete own" on public.flyers;
create policy "flyers: read own" on public.flyers for select to authenticated using (user_id = (select auth.uid()));
create policy "flyers: insert own" on public.flyers for insert to authenticated with check (user_id = (select auth.uid()));
create policy "flyers: update own" on public.flyers for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "flyers: delete own" on public.flyers for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.flyers from anon, authenticated;
grant select, insert, update, delete on public.flyers to authenticated;

-- At most 40 flyers per person.
create or replace function public.flyers_cap() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.flyers f where f.user_id = new.user_id) >= 40 then
    raise exception 'You have 40 flyers saved. Delete an old one to make a new one.';
  end if;
  return new;
end $$;
revoke all on function public.flyers_cap() from public, anon, authenticated;
drop trigger if exists flyers_cap on public.flyers;
create trigger flyers_cap before insert on public.flyers for each row execute function public.flyers_cap();
