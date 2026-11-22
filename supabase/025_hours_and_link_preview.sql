-- 025 (2026-11-22): Business hours in Build, and a link-preview photo choice for published sites. Safe to re-run.
--
-- 1. business_hours: one row per person, the business's opening hours as exact facts. Build sends them to build-site
--    as a separate field (not part of the 1,500-character description) and saves them here for reuse (menu footer,
--    flyers, Google data later). Shape of `hours`:
--      { "days": { "mon": [["09:00","17:00"]], "tue": [["11:00","14:00"],["17:00","22:00"]], "sun": "closed", ... },
--        "note": "Closed Thanksgiving and Christmas Day" }
--    A day that's missing is "not stated" (left off the site). At most two time ranges a day. A close time earlier
--    than the open time means after midnight (e.g. 17:00 to 02:00).
-- 2. sites.preview: the picture shown when someone shares the site's link (Open Graph). 'auto' = the first photo on
--    the page, else the logo; 'logo'; or one of the owner's photo ids. publish_site takes it as an optional third
--    argument (old callers without it keep the saved choice), and the Worker adds the og:/twitter: tags.

-- ---------- 1. business hours ----------
create or replace function public.valid_hours(h jsonb) returns boolean language plpgsql immutable set search_path = '' as $$
declare
  k text; v jsonb; r jsonb;
begin
  if h is null then return true; end if;
  if jsonb_typeof(h) <> 'object' then return false; end if;
  if exists (select 1 from jsonb_object_keys(h) x where x not in ('days', 'note')) then return false; end if;
  if h ? 'note' and (jsonb_typeof(h -> 'note') <> 'string' or char_length(h ->> 'note') > 200) then return false; end if;
  if not h ? 'days' then return true; end if;
  if jsonb_typeof(h -> 'days') <> 'object' then return false; end if;
  for k, v in select * from jsonb_each(h -> 'days') loop
    if k not in ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun') then return false; end if;
    if v = '"closed"'::jsonb then continue; end if;
    if jsonb_typeof(v) <> 'array' or jsonb_array_length(v) not between 1 and 2 then return false; end if;
    for r in select * from jsonb_array_elements(v) loop
      if jsonb_typeof(r) <> 'array' or jsonb_array_length(r) <> 2 then return false; end if;
      if coalesce(r ->> 0, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' or coalesce(r ->> 1, '') !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then return false; end if;
      if r ->> 0 = r ->> 1 then return false; end if;
    end loop;
  end loop;
  return true;
end $$;

create table if not exists public.business_hours (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  hours jsonb not null default '{}'::jsonb check (public.valid_hours(hours) and pg_column_size(hours) < 4000),
  updated_at timestamptz not null default now()
);
alter table public.business_hours enable row level security;
drop policy if exists "business_hours: read own" on public.business_hours;
drop policy if exists "business_hours: insert own" on public.business_hours;
drop policy if exists "business_hours: update own" on public.business_hours;
drop policy if exists "business_hours: delete own" on public.business_hours;
create policy "business_hours: read own" on public.business_hours for select to authenticated using (user_id = (select auth.uid()));
create policy "business_hours: insert own" on public.business_hours for insert to authenticated with check (user_id = (select auth.uid()));
create policy "business_hours: update own" on public.business_hours for update to authenticated using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "business_hours: delete own" on public.business_hours for delete to authenticated using (user_id = (select auth.uid()));
revoke all on public.business_hours from anon, authenticated;
grant select, insert, delete on public.business_hours to authenticated;
grant update (hours, updated_at) on public.business_hours to authenticated;
grant select on public.business_hours to service_role;

-- ---------- 2. link preview ----------
alter table public.sites add column if not exists preview text not null default 'auto';
alter table public.sites drop constraint if exists sites_preview_check;
alter table public.sites add constraint sites_preview_check check (
  preview in ('auto', 'logo') or preview ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$');

drop function if exists public.publish_site(uuid, text);
create or replace function public.publish_site(p_build_id uuid, p_slug text, p_preview text default null) returns json language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s text := lower(trim(p_slug));
  pv text := lower(trim(coalesce(p_preview, '')));
  out_html text;
  old text;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if not public.can_publish(me) then
    raise exception 'Publishing isn''t included in your plan. Choose a plan with publishing in Your account.';
  end if;
  if s !~ '^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$' or s ~ '--' then
    raise exception 'Use 3 to 32 lowercase letters, numbers or single dashes, starting and ending with a letter or number.';
  end if;
  if public.slug_reserved(s) then raise exception 'That name is reserved. Try another.'; end if;
  -- No choice sent (an older page or Worker): keep the saved one.
  if pv = '' then pv := coalesce((select x.preview from public.sites x where x.user_id = me), 'auto'); end if;
  if pv not in ('auto', 'logo') then
    if pv !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.site_photos p where p.id = pv::uuid and p.user_id = me) then
      raise exception 'That link preview photo isn''t in your photos any more. Choose another.';
    end if;
  end if;
  select o.html into out_html from public.build_outputs o where o.build_id = p_build_id and o.user_id = me;
  if out_html is null then raise exception 'That build isn''t available to publish. Build the site again, then publish.'; end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_sites'));
  if exists (select 1 from public.sites x where x.slug = s and x.user_id <> me)
     or exists (select 1 from public.online_menus m where m.slug = s and m.user_id <> me) then
    raise exception 'That name is taken. Try another.';
  end if;
  select x.slug into old from public.sites x where x.user_id = me;
  insert into public.sites (user_id, slug, build_id, published_at, preview) values (me, s, p_build_id, now(), pv)
  on conflict (user_id) do update set slug = excluded.slug, build_id = excluded.build_id, published_at = now(), preview = excluded.preview;
  return json_build_object('slug', s, 'html', out_html, 'old_slug', case when old is distinct from s then old end,
    'logo', (select k.logo from public.brand_kits k where k.user_id = me), 'preview', pv);
end $$;

create or replace function public.my_site() returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'can_publish', public.can_publish(auth.uid()),
    'slug', (select x.slug from public.sites x where x.user_id = auth.uid()),
    'published_at', (select x.published_at from public.sites x where x.user_id = auth.uid()),
    'preview', coalesce((select x.preview from public.sites x where x.user_id = auth.uid()), 'auto'),
    'messages', (select count(*) from public.site_messages m where m.user_id = auth.uid()));
$$;

revoke all on function public.valid_hours(jsonb) from public, anon;
grant execute on function public.valid_hours(jsonb) to authenticated, service_role; -- the table check runs as the person saving
revoke all on function public.publish_site(uuid, text, text), public.my_site() from public, anon;
grant execute on function public.publish_site(uuid, text, text), public.my_site() to authenticated;
