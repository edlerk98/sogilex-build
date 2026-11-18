-- Sogilex publishing (applied 2026-11-18). Safe to re-run. See docs/PUBLISHING.md.
-- Requires 003_build.sql (build_generations, build_limits).

create table if not exists public.build_outputs (
  build_id uuid primary key references public.build_generations (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  html text not null check (char_length(html) <= 200000),
  created_at timestamptz not null default now()
);
create index if not exists build_outputs_user on public.build_outputs (user_id, created_at desc);
alter table public.build_outputs enable row level security;
revoke all on public.build_outputs from anon, authenticated;

create table if not exists public.sites (
  user_id uuid primary key references auth.users (id) on delete cascade,
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$' and slug !~ '--'),
  build_id uuid references public.build_generations (id) on delete set null,
  published_at timestamptz not null default now()
);
alter table public.sites enable row level security;
drop policy if exists "sites: read own" on public.sites;
create policy "sites: read own" on public.sites for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.sites from anon, authenticated;
grant select on public.sites to authenticated;

create table if not exists public.site_messages (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  slug text not null,
  fields jsonb not null,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists site_messages_user on public.site_messages (user_id, created_at desc);
create index if not exists site_messages_slug on public.site_messages (slug, created_at);
create index if not exists site_messages_ip on public.site_messages (ip_hash, created_at);
alter table public.site_messages enable row level security;
drop policy if exists "site_messages: read own" on public.site_messages;
create policy "site_messages: read own" on public.site_messages for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.site_messages from anon, authenticated;
grant select on public.site_messages to authenticated;

create or replace function public.slug_reserved(s text)
returns boolean language sql immutable set search_path = '' as $$
  select s = any (array['www','api','admin','app','mail','email','smtp','imap','pop','ftp','ns1','ns2','cdn','static','assets',
    'build','atlas','sogilex','support','help','status','blog','docs','dev','test','staging','login','signin','signup',
    'account','accounts','billing','pay','payments','abuse','security','root','owner','official','sites','site','www1']);
$$;

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
  if exists (select 1 from public.sites x where x.slug = s and x.user_id <> me) then
    raise exception 'That name is taken. Try another.';
  end if;
  select x.slug into old from public.sites x where x.user_id = me;
  insert into public.sites (user_id, slug, build_id, published_at) values (me, s, p_build_id, now())
  on conflict (user_id) do update set slug = excluded.slug, build_id = excluded.build_id, published_at = now();
  return json_build_object('slug', s, 'html', out_html, 'old_slug', case when old is distinct from s then old end);
end;
$$;

create or replace function public.unpublish_site()
returns text language sql security definer set search_path = '' as $$
  delete from public.sites where user_id = auth.uid() returning slug;
$$;

create or replace function public.my_site()
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'can_publish', coalesce((select l.can_publish from public.build_limits l where l.user_id = auth.uid()), false),
    'slug', (select x.slug from public.sites x where x.user_id = auth.uid()),
    'published_at', (select x.published_at from public.sites x where x.user_id = auth.uid()),
    'messages', (select count(*) from public.site_messages m where m.user_id = auth.uid()));
$$;

create or replace function public.submit_site_message(p_slug text, p_fields jsonb, p_ip_hash text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare owner uuid;
begin
  select x.user_id into owner from public.sites x where x.slug = lower(p_slug);
  if owner is null then return false; end if;
  if jsonb_typeof(p_fields) <> 'object' or pg_column_size(p_fields) > 12000 then return false; end if;
  if (select count(*) from public.site_messages m where m.slug = lower(p_slug) and m.created_at > now() - interval '1 hour') >= 30 then return false; end if;
  if p_ip_hash is not null and (select count(*) from public.site_messages m where m.ip_hash = p_ip_hash and m.created_at > now() - interval '1 hour') >= 5 then return false; end if;
  insert into public.site_messages (user_id, slug, fields, ip_hash) values (owner, lower(p_slug), p_fields, left(p_ip_hash, 64));
  return true;
end;
$$;

revoke all on function public.slug_reserved(text) from public;
revoke all on function public.publish_site(uuid, text) from public, anon;
revoke all on function public.unpublish_site() from public, anon;
revoke all on function public.my_site() from public, anon;
revoke all on function public.submit_site_message(text, jsonb, text) from public;
grant execute on function public.publish_site(uuid, text) to authenticated;
grant execute on function public.unpublish_site() to authenticated;
grant execute on function public.my_site() to authenticated;
grant execute on function public.submit_site_message(text, jsonb, text) to anon, authenticated;
