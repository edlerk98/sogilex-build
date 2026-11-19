-- Sogilex Menus: the online menu at https://<name>.sogilex.net/menu. Safe to re-run. Needs 004 and 005.
-- The owner's saved menu text (the same JSON the Menus form saves) is copied here when they put it online, and again
-- on every save after that. The Worker builds the page from this text itself (everything escaped), so nothing the
-- owner sends is ever served as HTML. A name belongs to one person across websites and online menus.

create table if not exists public.online_menus (
  user_id uuid primary key references auth.users (id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$' and slug !~ '--'),
  data jsonb not null check (pg_column_size(data) < 200000),
  published_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.online_menus enable row level security;
drop policy if exists "online_menus: read own" on public.online_menus;
create policy "online_menus: read own" on public.online_menus for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.online_menus from anon, authenticated;
grant select on public.online_menus to authenticated;

-- Put the menu online (first time: choose the name), or update it.
create or replace function public.publish_menu(p_slug text, p_data jsonb)
returns json language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s text := lower(trim(coalesce(p_slug, '')));
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if not coalesce((select l.can_publish from public.build_limits l where l.user_id = me), false) then
    raise exception 'Online menus are in a closed beta for now.';
  end if;
  if s = '' then select m.slug into s from public.online_menus m where m.user_id = me; end if;
  if s is null or s !~ '^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$' or s ~ '--' then
    raise exception 'Use 3 to 32 lowercase letters, numbers or single dashes, starting and ending with a letter or number.';
  end if;
  if public.slug_reserved(s) then raise exception 'That name is reserved. Try another.'; end if;
  if jsonb_typeof(p_data) <> 'object' or jsonb_typeof(p_data -> 'sections') <> 'array' then raise exception 'That menu couldn''t be read.'; end if;
  if pg_column_size(p_data) >= 200000 then raise exception 'That menu is too long to put online.'; end if;
  -- Prices read from a photo carry "chk" until the owner has checked them: they never go online unchecked.
  if p_data::text like '%"chk"%' then raise exception 'Check the highlighted prices first. They were read from a photo.'; end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_sites'));
  if exists (select 1 from public.sites x where x.slug = s and x.user_id <> me)
     or exists (select 1 from public.online_menus m where m.slug = s and m.user_id <> me) then
    raise exception 'That name is taken. Try another.';
  end if;
  insert into public.online_menus (user_id, slug, data, published_at, updated_at) values (me, s, p_data, now(), now())
  on conflict (user_id) do update set slug = excluded.slug, data = excluded.data, updated_at = now();
  return json_build_object('slug', s, 'url', 'https://' || s || '.sogilex.net/menu');
end;
$$;

create or replace function public.unpublish_menu()
returns text language sql security definer set search_path = '' as $$
  delete from public.online_menus where user_id = auth.uid() returning slug;
$$;

-- For the Menus page: is the menu online, may this person publish, and their website's name (a good default).
create or replace function public.my_online_menu()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'can_publish', coalesce((select l.can_publish from public.build_limits l where l.user_id = auth.uid()), false),
    'slug', (select m.slug from public.online_menus m where m.user_id = auth.uid()),
    'updated_at', (select m.updated_at from public.online_menus m where m.user_id = auth.uid()),
    'site_slug', (select x.slug from public.sites x where x.user_id = auth.uid()));
$$;

-- For the Worker (public): a published menu's text, its owner's logo and logo colours. Nothing else.
create or replace function public.public_menu(p_slug text)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('data', m.data, 'logo', k.logo, 'colors', coalesce(k.colors, '[]'::jsonb))
  from public.online_menus m left join public.brand_kits k on k.user_id = m.user_id
  where m.slug = lower(p_slug);
$$;

-- The website publisher must also respect names used by someone else's online menu.
create or replace function public.publish_site(p_build_id uuid, p_slug text)
returns json language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s text := lower(trim(p_slug));
  out_html text;
  old text;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if not coalesce((select l.can_publish from public.build_limits l where l.user_id = me), false) then
    raise exception 'Publishing is in a closed beta for now.';
  end if;
  if s !~ '^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$' or s ~ '--' then
    raise exception 'Use 3 to 32 lowercase letters, numbers or single dashes, starting and ending with a letter or number.';
  end if;
  if public.slug_reserved(s) then raise exception 'That name is reserved. Try another.'; end if;
  select o.html into out_html from public.build_outputs o where o.build_id = p_build_id and o.user_id = me;
  if out_html is null then raise exception 'That build isn''t available to publish. Build the site again, then publish.'; end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_sites'));
  if exists (select 1 from public.sites x where x.slug = s and x.user_id <> me)
     or exists (select 1 from public.online_menus m where m.slug = s and m.user_id <> me) then
    raise exception 'That name is taken. Try another.';
  end if;
  select x.slug into old from public.sites x where x.user_id = me;
  insert into public.sites (user_id, slug, build_id, published_at) values (me, s, p_build_id, now())
  on conflict (user_id) do update set slug = excluded.slug, build_id = excluded.build_id, published_at = now();
  return json_build_object('slug', s, 'html', out_html, 'old_slug', case when old is distinct from s then old end,
    'logo', (select k.logo from public.brand_kits k where k.user_id = me));
end;
$$;

revoke all on function public.publish_menu(text, jsonb) from public, anon;
revoke all on function public.unpublish_menu() from public, anon;
revoke all on function public.my_online_menu() from public, anon;
revoke all on function public.public_menu(text) from public;
grant execute on function public.publish_menu(text, jsonb) to authenticated;
grant execute on function public.unpublish_menu() to authenticated;
grant execute on function public.my_online_menu() to authenticated;
grant execute on function public.public_menu(text) to anon, authenticated;
