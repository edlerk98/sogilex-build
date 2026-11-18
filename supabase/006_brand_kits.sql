-- Sogilex brand kit (applied 2026-11-18): one logo per person, stored as a small PNG data URL (resized in the
-- browser by assets/brand.js) plus the colours picked out of it. publish_site (004) also returns the logo
-- so published sites can show it; see the 2026-11-18 version of publish_site in the database.
create table if not exists public.brand_kits (
  user_id uuid primary key references auth.users (id) on delete cascade,
  logo text check (logo is null or (logo like 'data:image/png;base64,%' and char_length(logo) <= 400000)),
  logo_name text check (logo_name is null or char_length(logo_name) <= 120),
  colors jsonb not null default '[]'::jsonb check (jsonb_typeof(colors) = 'array' and jsonb_array_length(colors) <= 6),
  updated_at timestamptz not null default now()
);
alter table public.brand_kits enable row level security;
drop policy if exists "brand_kits: read own" on public.brand_kits;
drop policy if exists "brand_kits: insert own" on public.brand_kits;
drop policy if exists "brand_kits: update own" on public.brand_kits;
drop policy if exists "brand_kits: delete own" on public.brand_kits;
create policy "brand_kits: read own" on public.brand_kits for select to authenticated using (user_id = (select auth.uid()));
create policy "brand_kits: insert own" on public.brand_kits for insert to authenticated with check (user_id = (select auth.uid()));
create policy "brand_kits: update own" on public.brand_kits for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "brand_kits: delete own" on public.brand_kits for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.brand_kits from anon, authenticated;
grant select, insert, update, delete on public.brand_kits to authenticated;
