-- Sogilex plans: what each account may do comes from its plan. Safe to re-run. Needs 003-020.
--
-- * public.plans: the catalogue (prices in cents, limits). Anyone may read it; only the owner changes it (dashboard).
-- * public.subscriptions: one row per account that isn't on the default plan. Users can READ their own row but never
--   write it: plans change only through the owner (Supabase dashboard, Table Editor) or, later, the Stripe webhook
--   (service role). A user asking for a change only records a request (request_plan_change).
-- * public.app_settings 'default_plan': the plan of every account without a row. 'beta' during the beta (exactly the
--   limits the tools had before this file); switch it to 'trial' at launch.
-- * Limits have a window: 'day' (last 24 hours), 'month' (since the billing period started, else the calendar month)
--   or 'ever' (the free trial: once). Every claim_* function and cap trigger reads them, so nothing in the browser can
--   get around them. build_limits (per-person overrides) still wins for builds and publishing.

create table if not exists public.plans (
  id text primary key check (id ~ '^[a-z_]{2,20}$'),
  name text not null,
  blurb text not null default '',
  month_cents integer,          -- null = not sold monthly
  year_cents integer,           -- null = not sold yearly
  setup_cents integer not null default 0,
  can_publish boolean not null default false,
  limits jsonb not null,        -- { window: day|month|ever, builds, edits, imports, captions, flyers, posts, docs }
  public boolean not null default true,  -- shown on the account page's plan chooser
  sort integer not null default 0
);
alter table public.plans enable row level security;
drop policy if exists "plans: anyone reads" on public.plans;
create policy "plans: anyone reads" on public.plans for select to anon, authenticated using (true);
revoke all on public.plans from anon, authenticated;
grant select on public.plans to anon, authenticated;

insert into public.plans (id, name, blurb, month_cents, year_cents, setup_cents, can_publish, limits, public, sort) values
  ('beta', 'Beta', 'Everything free while Sogilex is in beta, with daily limits.', null, null, 0, true,
   '{"window":"day","builds":3,"edits":30,"imports":10,"captions":40,"flyers":40,"posts":100,"docs":2000}', false, 0),
  ('trial', 'Free trial', 'Try each tool once: one website (with up to 5 changes), one menu, flyer, post and invoice.', 0, null, 0, false,
   '{"window":"ever","builds":1,"edits":5,"imports":1,"captions":3,"flyers":1,"posts":1,"docs":1}', true, 10),
  ('diy', 'Do it yourself', 'Every tool, your website published and your online menu with its QR code.', 1900, 19000, 0, true,
   '{"window":"month","builds":3,"edits":30,"imports":10,"captions":50,"flyers":40,"posts":100,"docs":2000}', true, 20),
  ('dfy_menu', 'Menu (done for you)', 'We design your menu, put it online behind a QR code and keep it up to date.', 2500, 25000, 14900, true,
   '{"window":"month","builds":3,"edits":30,"imports":10,"captions":50,"flyers":40,"posts":100,"docs":2000}', true, 30),
  ('dfy_site', 'Menu + website (done for you)', 'Everything in Menu, plus a one-page website we keep up to date.', 4500, 45000, 34900, true,
   '{"window":"month","builds":3,"edits":30,"imports":10,"captions":50,"flyers":40,"posts":100,"docs":2000}', true, 40),
  ('dfy_all', 'All-in-one (done for you)', 'Menu + website, plus 4 social posts and 1 flyer a month, made for you.', 14900, 149000, 49900, true,
   '{"window":"month","builds":3,"edits":30,"imports":10,"captions":50,"flyers":40,"posts":100,"docs":2000}', true, 50),
  ('team', 'Team', 'Sogilex team accounts.', null, null, 0, true,
   '{"window":"day","builds":20,"edits":100,"imports":50,"captions":200,"flyers":200,"posts":500,"docs":5000}', false, 90)
on conflict (id) do update set name = excluded.name, blurb = excluded.blurb, month_cents = excluded.month_cents,
  year_cents = excluded.year_cents, setup_cents = excluded.setup_cents, can_publish = excluded.can_publish,
  limits = excluded.limits, public = excluded.public, sort = excluded.sort;

create table if not exists public.app_settings (key text primary key, value text not null);
alter table public.app_settings enable row level security;
revoke all on public.app_settings from anon, authenticated;
insert into public.app_settings (key, value) values ('default_plan', 'beta') on conflict (key) do nothing;

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_id text not null references public.plans (id),
  billing text check (billing in ('month', 'year')),
  status text not null default 'active' check (status in ('active', 'trialing', 'past_due', 'canceled')),
  current_period_start timestamptz,
  current_period_end timestamptz,
  stripe_customer_id text,
  stripe_subscription_id text,
  requested_plan_id text references public.plans (id),  -- what the person asked to change to (until payments exist)
  requested_billing text check (requested_billing in ('month', 'year')),
  requested_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.subscriptions enable row level security;
drop policy if exists "subscriptions: read own" on public.subscriptions;
create policy "subscriptions: read own" on public.subscriptions for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;
grant select, insert, update, delete on public.subscriptions to service_role;
grant select on public.plans to service_role;

-- ---------- helpers ----------
-- The account's plan: its subscription if active (or in trial / a payment retry), else the default plan.
create or replace function public.plan_of(p_user uuid) returns public.plans language sql stable security definer set search_path = '' as $$
  select p.* from public.plans p
  where p.id = coalesce(
    (select s.plan_id from public.subscriptions s where s.user_id = p_user and s.status in ('active', 'trialing', 'past_due')),
    (select a.value from public.app_settings a where a.key = 'default_plan'),
    'beta');
$$;
-- Where the current limit window starts.
create or replace function public.plan_window_start(p_user uuid) returns timestamptz language sql stable security definer set search_path = '' as $$
  select case (public.plan_of(p_user)).limits ->> 'window'
    when 'day' then now() - interval '24 hours'
    when 'ever' then '-infinity'::timestamptz
    else coalesce((select s.current_period_start from public.subscriptions s where s.user_id = p_user and s.current_period_start <= now()),
                  date_trunc('month', now()))
  end;
$$;
create or replace function public.plan_limit(p_user uuid, p_key text) returns integer language sql stable security definer set search_path = '' as $$
  select coalesce(((public.plan_of(p_user)).limits ->> p_key)::integer, 0);
$$;
-- "today", "this month" or "on the free trial", for messages.
create or replace function public.plan_when(p_user uuid) returns text language sql stable security definer set search_path = '' as $$
  select case (public.plan_of(p_user)).limits ->> 'window' when 'day' then 'today' when 'ever' then 'on the free trial' else 'this month' end;
$$;
create or replace function public.plan_used(p_user uuid, p_kind text) returns integer language sql stable security definer set search_path = '' as $$
  select count(*)::integer from public.build_generations g
  where g.user_id = p_user and g.kind = p_kind and g.status <> 'failed' and g.created_at > public.plan_window_start(p_user);
$$;
create or replace function public.can_publish(p_user uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select (public.plan_of(p_user)).can_publish or coalesce((select l.can_publish from public.build_limits l where l.user_id = p_user), false);
$$;
-- The friendly message when a limit is reached.
create or replace function public.plan_full(p_user uuid, p_used integer, p_what text) returns text language sql stable security definer set search_path = '' as $$
  select case (public.plan_of(p_user)).limits ->> 'window'
    when 'day' then format('You''ve used your %s %s for today. Try again tomorrow.', p_used, p_what)
    when 'ever' then format('The free trial includes %s %s. Choose a plan in Your account to keep going.', p_used, p_what)
    else format('You''ve used your %s %s for this month. They reset when your next month starts, or choose a bigger plan in Your account.', p_used, p_what)
  end;
$$;

-- ---------- the AI limits (same rules as before for failures and the everyone-wide caps) ----------
create or replace function public.claim_build_slot() returns uuid language plpgsql security definer set search_path = '' as $$
declare
  failed_per_day   constant integer := 5;
  everyone_per_day constant integer := 50;
  me uuid := auth.uid();
  allowed integer;
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  allowed := coalesce((select l.per_day from public.build_limits l where l.user_id = me), public.plan_limit(me, 'builds'));
  perform pg_advisory_xact_lock(hashtext('sogilex_build_slots'));
  if public.plan_used(me, 'build') >= allowed then
    raise exception '%', public.plan_full(me, allowed, case when allowed = 1 then 'website build' else 'website builds' end);
  end if;
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'build' and status = 'failed' and created_at > now() - interval '24 hours') >= failed_per_day then
    raise exception 'Too many builds didn''t finish today. Please try again tomorrow.';
  end if;
  if (select count(*) from public.build_generations where kind = 'build' and created_at > now() - interval '24 hours') >= everyone_per_day then
    raise exception 'Sogilex Build has reached today''s limit. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id) values (me) returning id into new_id;
  return new_id;
end $$;

create or replace function public.claim_edit_slot(p_parent uuid) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  failed_per_day   constant integer := 10;
  everyone_per_day constant integer := 500;
  me uuid := auth.uid();
  allowed integer;
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if not exists (select 1 from public.build_outputs o where o.build_id = p_parent and o.user_id = me) then
    raise exception 'That site isn''t available to edit. Open it again from Your sites.';
  end if;
  allowed := public.plan_limit(me, 'edits');
  perform pg_advisory_xact_lock(hashtext('sogilex_edit_slots'));
  if public.plan_used(me, 'edit') >= allowed then
    raise exception '%', public.plan_full(me, allowed, case when allowed = 1 then 'website change' else 'website changes' end);
  end if;
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'edit' and status = 'failed' and created_at > now() - interval '24 hours') >= failed_per_day then
    raise exception 'Too many edits didn''t work today. Please try again tomorrow.';
  end if;
  if (select count(*) from public.build_generations where kind = 'edit' and created_at > now() - interval '24 hours') >= everyone_per_day then
    raise exception 'Editing has reached today''s limit. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id, kind, parent_id) values (me, 'edit', p_parent) returning id into new_id;
  return new_id;
end $$;

create or replace function public.claim_import_slot() returns uuid language plpgsql security definer set search_path = '' as $$
declare
  failed_per_day   constant integer := 10;
  everyone_per_day constant integer := 200;
  me uuid := auth.uid();
  allowed integer;
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  allowed := public.plan_limit(me, 'imports');
  perform pg_advisory_xact_lock(hashtext('sogilex_import_slots'));
  if public.plan_used(me, 'import') >= allowed then
    raise exception '%', public.plan_full(me, allowed, case when allowed = 1 then 'menu read from a photo' else 'menus read from photos' end);
  end if;
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'import' and status = 'failed' and created_at > now() - interval '24 hours') >= failed_per_day then
    raise exception 'Too many menu photos couldn''t be read today. Please try again tomorrow.';
  end if;
  if (select count(*) from public.build_generations where kind = 'import' and created_at > now() - interval '24 hours') >= everyone_per_day then
    raise exception 'Reading menus from photos has reached today''s limit. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id, kind) values (me, 'import') returning id into new_id;
  return new_id;
end $$;

create or replace function public.claim_caption_slot() returns uuid language plpgsql security definer set search_path = '' as $$
declare
  failed_per_day   constant integer := 10;
  everyone_per_day constant integer := 1000;
  me uuid := auth.uid();
  allowed integer;
  new_id uuid;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  allowed := public.plan_limit(me, 'captions');
  perform pg_advisory_xact_lock(hashtext('sogilex_caption_slots'));
  if public.plan_used(me, 'caption') >= allowed then
    raise exception '%', public.plan_full(me, allowed, case when allowed = 1 then 'caption' else 'captions' end);
  end if;
  if (select count(*) from public.build_generations
      where user_id = me and kind = 'caption' and status = 'failed' and created_at > now() - interval '24 hours') >= failed_per_day then
    raise exception 'Too many captions didn''t work today. Please try again tomorrow.';
  end if;
  if (select count(*) from public.build_generations where kind = 'caption' and created_at > now() - interval '24 hours') >= everyone_per_day then
    raise exception 'Caption writing has reached today''s limit. Please try again tomorrow.';
  end if;
  insert into public.build_generations (user_id, kind) values (me, 'caption') returning id into new_id;
  return new_id;
end $$;

-- "N left" counts the tools show.
create or replace function public.build_quota() returns integer language sql stable security definer set search_path = '' as $$
  select greatest(0, coalesce((select l.per_day from public.build_limits l where l.user_id = auth.uid()), public.plan_limit(auth.uid(), 'builds'))
    - public.plan_used(auth.uid(), 'build'));
$$;
create or replace function public.edit_quota() returns integer language sql stable security definer set search_path = '' as $$
  select greatest(0, public.plan_limit(auth.uid(), 'edits') - public.plan_used(auth.uid(), 'edit'));
$$;
create or replace function public.caption_quota() returns integer language sql stable security definer set search_path = '' as $$
  select greatest(0, public.plan_limit(auth.uid(), 'captions') - public.plan_used(auth.uid(), 'caption'));
$$;

-- ---------- how many things can be saved (flyers, posts, quotes and invoices) ----------
create or replace function public.plan_item_cap() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  k text := tg_argv[0];          -- 'flyers' | 'posts' | 'docs'
  allowed integer := public.plan_limit(new.user_id, k);
  n integer;
  what text := case k when 'flyers' then 'flyer' when 'posts' then 'post' else 'quote or invoice' end;
begin
  if k = 'flyers' then select count(*) into n from public.flyers x where x.user_id = new.user_id;
  elsif k = 'posts' then select count(*) into n from public.posts x where x.user_id = new.user_id;
  else select count(*) into n from public.inv_docs x where x.user_id = new.user_id; end if;
  if n >= allowed then
    if (public.plan_of(new.user_id)).limits ->> 'window' = 'ever' then
      raise exception 'The free trial includes % %. Choose a plan in Your account to make more.', allowed, case when allowed = 1 then what else what || 's' end;
    end if;
    raise exception 'You have % %s saved, the most your plan allows. Delete an old one to make a new one.', n, what;
  end if;
  return new;
end $$;
revoke all on function public.plan_item_cap() from public, anon, authenticated;
drop trigger if exists flyers_plan_cap on public.flyers;
create trigger flyers_plan_cap before insert on public.flyers for each row execute function public.plan_item_cap('flyers');
drop trigger if exists posts_plan_cap on public.posts;
create trigger posts_plan_cap before insert on public.posts for each row execute function public.plan_item_cap('posts');
drop trigger if exists inv_docs_plan_cap on public.inv_docs;
create trigger inv_docs_plan_cap before insert on public.inv_docs for each row execute function public.plan_item_cap('docs');

-- ---------- publishing follows the plan ----------
create or replace function public.publish_site(p_build_id uuid, p_slug text) returns json language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s text := lower(trim(p_slug));
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
end $$;

create or replace function public.publish_menu(p_slug text, p_data jsonb) returns json language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s text := lower(trim(coalesce(p_slug, '')));
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if not public.can_publish(me) then
    raise exception 'Online menus aren''t included in your plan. Choose a plan with publishing in Your account.';
  end if;
  if s = '' then select m.slug into s from public.online_menus m where m.user_id = me; end if;
  if s is null or s !~ '^[a-z0-9]([a-z0-9-]{1,30})[a-z0-9]$' or s ~ '--' then
    raise exception 'Use 3 to 32 lowercase letters, numbers or single dashes, starting and ending with a letter or number.';
  end if;
  if public.slug_reserved(s) then raise exception 'That name is reserved. Try another.'; end if;
  if jsonb_typeof(p_data) <> 'object' or jsonb_typeof(p_data -> 'sections') <> 'array' then raise exception 'That menu couldn''t be read.'; end if;
  if pg_column_size(p_data) >= 200000 then raise exception 'That menu is too long to put online.'; end if;
  if p_data::text like '%"chk"%' then raise exception 'Check the highlighted prices first. They were read from a photo.'; end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_sites'));
  if exists (select 1 from public.sites x where x.slug = s and x.user_id <> me)
     or exists (select 1 from public.online_menus m where m.slug = s and m.user_id <> me) then
    raise exception 'That name is taken. Try another.';
  end if;
  insert into public.online_menus (user_id, slug, data, published_at, updated_at) values (me, s, p_data, now(), now())
  on conflict (user_id) do update set slug = excluded.slug, data = excluded.data, updated_at = now();
  return json_build_object('slug', s, 'url', 'https://' || s || '.sogilex.net/menu');
end $$;

create or replace function public.my_site() returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'can_publish', public.can_publish(auth.uid()),
    'slug', (select x.slug from public.sites x where x.user_id = auth.uid()),
    'published_at', (select x.published_at from public.sites x where x.user_id = auth.uid()),
    'messages', (select count(*) from public.site_messages m where m.user_id = auth.uid()));
$$;
create or replace function public.my_online_menu() returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'can_publish', public.can_publish(auth.uid()),
    'slug', (select m.slug from public.online_menus m where m.user_id = auth.uid()),
    'updated_at', (select m.updated_at from public.online_menus m where m.user_id = auth.uid()),
    'site_slug', (select x.slug from public.sites x where x.user_id = auth.uid()));
$$;

-- ---------- the account page ----------
-- Your plan, what it allows and what you've used in the current window.
create or replace function public.my_plan() returns json language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id), p as (select (public.plan_of((select id from me))).*), s as (
    select * from public.subscriptions where user_id = (select id from me))
  select json_build_object(
    'plan', (select row_to_json(p) from p),
    'billing', (select billing from s), 'status', (select status from s),
    'period_end', (select current_period_end from s),
    'requested_plan', (select requested_plan_id from s), 'requested_billing', (select requested_billing from s), 'requested_at', (select requested_at from s),
    'when', public.plan_when((select id from me)),
    'can_publish', public.can_publish((select id from me)),
    'builds_allowed', coalesce((select l.per_day from public.build_limits l where l.user_id = (select id from me)), public.plan_limit((select id from me), 'builds')),
    'used', json_build_object(
      'builds', public.plan_used((select id from me), 'build'), 'edits', public.plan_used((select id from me), 'edit'),
      'imports', public.plan_used((select id from me), 'import'), 'captions', public.plan_used((select id from me), 'caption'),
      'flyers', (select count(*) from public.flyers where user_id = (select id from me)),
      'posts', (select count(*) from public.posts where user_id = (select id from me)),
      'docs', (select count(*) from public.inv_docs where user_id = (select id from me))));
$$;

-- Until payments exist, choosing a plan records the request (the owner sees it in the subscriptions table) and
-- changes nothing. Payments will replace this with a Stripe checkout; the webhook then sets plan_id.
create or replace function public.request_plan_change(p_plan text, p_billing text) returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if not exists (select 1 from public.plans p where p.id = p_plan and p.public) then raise exception 'That plan isn''t available.'; end if;
  if p_billing is not null and p_billing not in ('month', 'year') then raise exception 'Choose monthly or yearly.'; end if;
  insert into public.subscriptions (user_id, plan_id, requested_plan_id, requested_billing, requested_at)
  values (me, (public.plan_of(me)).id, p_plan, p_billing, now())
  on conflict (user_id) do update set requested_plan_id = excluded.requested_plan_id, requested_billing = excluded.requested_billing,
    requested_at = now(), updated_at = now();
end $$;

revoke all on function public.plan_of(uuid), public.plan_window_start(uuid), public.plan_limit(uuid, text), public.plan_when(uuid),
  public.plan_used(uuid, text), public.can_publish(uuid), public.plan_full(uuid, integer, text) from public, anon, authenticated;
revoke all on function public.my_plan(), public.request_plan_change(text, text) from public, anon;
grant execute on function public.my_plan(), public.request_plan_change(text, text) to authenticated;
revoke all on function public.claim_build_slot(), public.claim_edit_slot(uuid), public.claim_import_slot(), public.claim_caption_slot(),
  public.build_quota(), public.edit_quota(), public.caption_quota(), public.publish_site(uuid, text), public.publish_menu(text, jsonb),
  public.my_site(), public.my_online_menu() from public, anon;
grant execute on function public.claim_build_slot(), public.claim_edit_slot(uuid), public.claim_import_slot(), public.claim_caption_slot(),
  public.build_quota(), public.edit_quota(), public.caption_quota(), public.publish_site(uuid, text), public.publish_menu(text, jsonb),
  public.my_site(), public.my_online_menu() to authenticated;
