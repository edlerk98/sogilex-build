-- Sogilex Build: the owner's own photos for their website. Safe to re-run.
-- Photos are resized in the browser (at most 2000 px, JPEG) and stored privately in Storage at
-- site-photos/<user id>/<photo id>.jpg, with a small preview at <photo id>-t.jpg that Claude looks at.
-- Generated pages refer to a photo as sogilex:photo:<photo id>. Build swaps in a private link for the preview;
-- publishing copies the photos a site uses to Cloudflare and serves them from the site's own address.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('site-photos', 'site-photos', false, 3145728, array['image/jpeg'])
on conflict (id) do update set public = false, file_size_limit = 3145728, allowed_mime_types = array['image/jpeg'];

-- Each person reads, adds and removes files only in their own folder.
drop policy if exists "site photos: read own" on storage.objects;
create policy "site photos: read own" on storage.objects for select to authenticated
  using (bucket_id = 'site-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "site photos: add own" on storage.objects;
create policy "site photos: add own" on storage.objects for insert to authenticated
  with check (bucket_id = 'site-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists "site photos: remove own" on storage.objects;
create policy "site photos: remove own" on storage.objects for delete to authenticated
  using (bucket_id = 'site-photos' and (storage.foldername(name))[1] = (select auth.uid())::text);

create table if not exists public.site_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null default '' check (char_length(name) <= 80),
  width integer check (width between 1 and 4000),
  height integer check (height between 1 and 4000),
  bytes integer check (bytes between 1 and 3145728),
  created_at timestamptz not null default now()
);
create index if not exists site_photos_user on public.site_photos (user_id, created_at desc);
alter table public.site_photos enable row level security;

-- At most 60 photos per person.
create or replace function public.photo_count_ok()
returns boolean language sql stable security definer set search_path = '' as $$
  select (select count(*) from public.site_photos p where p.user_id = auth.uid()) < 60;
$$;
revoke all on function public.photo_count_ok() from public, anon;
grant execute on function public.photo_count_ok() to authenticated;

drop policy if exists "photos: read own" on public.site_photos;
create policy "photos: read own" on public.site_photos for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "photos: add own" on public.site_photos;
create policy "photos: add own" on public.site_photos for insert to authenticated
  with check (user_id = (select auth.uid()) and public.photo_count_ok());
drop policy if exists "photos: rename own" on public.site_photos;
create policy "photos: rename own" on public.site_photos for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "photos: remove own" on public.site_photos;
create policy "photos: remove own" on public.site_photos for delete to authenticated using (user_id = (select auth.uid()));

revoke all on public.site_photos from anon, authenticated;
grant select, insert, delete on public.site_photos to authenticated;
grant update (name) on public.site_photos to authenticated;
grant select on public.site_photos to service_role;
