-- 038 (2026-11-24): own web addresses (www.yourbusiness.com instead of name.sogilex.net). Safe to re-run.
-- Owner decided: a $5/month add-on to Do it yourself ($50/year on yearly plans); included in the done-for-you website plans,
-- Team and Complimentary. Sogilex doesn't sell domains: the customer points www at domains.sogilex.net (Cloudflare for SaaS
-- issues the certificate). Rows are written only by the `domains` Edge Function (service role) after it has asked
-- Cloudflare, never from the browser.

create table if not exists public.custom_domains (
  user_id uuid primary key references auth.users (id) on delete cascade,  -- one site per account, so one address
  hostname text not null unique check (char_length(hostname) <= 253 and hostname ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  cf_id text,                      -- Cloudflare custom hostname id
  status text not null default 'pending' check (status in ('pending', 'active', 'failed')),
  detail text,                     -- the last thing Cloudflare said, shown in Build
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.custom_domains enable row level security;
drop policy if exists "custom_domains: read own" on public.custom_domains;
create policy "custom_domains: read own" on public.custom_domains for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.custom_domains from anon, authenticated;
grant select on public.custom_domains to authenticated;
grant select, insert, update, delete on public.custom_domains to service_role;

-- The $5 add-on, copied from Stripe by the billing function.
alter table public.subscriptions add column if not exists domain_addon boolean not null default false;

-- May this account use its own web address right now?
create or replace function public.can_own_domain(p_user uuid) returns boolean language sql stable security definer set search_path = '' as $$
  select public.can_publish(p_user) and (
    (public.plan_of(p_user)).id in ('dfy_site', 'dfy_all', 'team', 'comp')
    or coalesce((select s.domain_addon from public.subscriptions s where s.user_id = p_user and s.status in ('active', 'trialing', 'past_due')), false));
$$;
revoke all on function public.can_own_domain(uuid) from public, anon, authenticated;
grant execute on function public.can_own_domain(uuid) to service_role;

-- For the Worker (anyone may ask; they only say which site an address shows, or which address a site uses).
-- An address counts only while it's active at Cloudflare and the owner may still use one: when the add-on or the plan
-- ends, the domain stops showing the site by itself.
create or replace function public.domain_site(p_host text) returns text language sql stable security definer set search_path = '' as $$
  select x.slug from public.custom_domains d join public.sites x on x.user_id = d.user_id
  where d.hostname = lower(p_host) and d.status = 'active' and public.can_own_domain(d.user_id);
$$;
create or replace function public.site_domain(p_slug text) returns text language sql stable security definer set search_path = '' as $$
  select d.hostname from public.sites x join public.custom_domains d on d.user_id = x.user_id
  where x.slug = lower(p_slug) and d.status = 'active' and public.can_own_domain(x.user_id);
$$;
revoke all on function public.domain_site(text), public.site_domain(text) from public;
grant execute on function public.domain_site(text), public.site_domain(text) to anon, authenticated;

-- For Build's "Your own web address" panel.
create or replace function public.my_domain() returns json language sql stable security definer set search_path = '' as $$
  select json_build_object(
    'eligible', public.can_own_domain(auth.uid()),
    'included', (public.plan_of(auth.uid())).id in ('dfy_site', 'dfy_all', 'team', 'comp'),
    'addon', coalesce((select s.domain_addon from public.subscriptions s where s.user_id = auth.uid() and s.status in ('active', 'trialing', 'past_due')), false),
    'plan', (public.plan_of(auth.uid())).id,
    'billing_managed', coalesce((select s.stripe_subscription_id is not null and s.status in ('active', 'trialing', 'past_due') from public.subscriptions s where s.user_id = auth.uid()), false),
    'site', (select x.slug from public.sites x where x.user_id = auth.uid()),
    'hostname', d.hostname, 'status', d.status, 'detail', d.detail)
  from (select 1) one left join public.custom_domains d on d.user_id = auth.uid();
$$;
revoke all on function public.my_domain() from public, anon;
grant execute on function public.my_domain() to authenticated;
