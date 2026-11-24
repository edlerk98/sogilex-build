-- 035 (2026-11-24): the free trial lasts 14 days (owner decided). Safe to re-run.
-- After that, an account with no plan of its own is on the hidden plan 'expired' ("Free trial ended"): nothing included,
-- and saved flyers, posts, menus and quotes/invoices can't be changed (they stay visible; choosing a plan unlocks them).
-- The clock starts at the LATER of the account's creation and app_settings 'trial_epoch' (set on switch-over day, so
-- accounts made during the beta get a full 14 days from then). Length: app_settings 'trial_days' (default 14).
-- Plans of their own (paid, comp, team) always come first, as before.

insert into public.plans (id, name, blurb, month_cents, year_cents, setup_cents, can_publish, limits, public, sort)
values ('expired', 'Free trial ended', 'Your free trial has ended. Choose a plan to keep making things.', 0, null, 0, false,
  '{"docs":0,"edits":0,"posts":0,"builds":0,"flyers":0,"window":"ever","imports":0,"captions":0}'::jsonb, false, 5)
on conflict (id) do update set name = excluded.name, blurb = excluded.blurb, limits = excluded.limits, can_publish = false, public = false;

-- When this account's free trial ends (or ended).
create or replace function public.trial_ends(p_user uuid) returns timestamptz language sql stable security definer set search_path = '' as $$
  select greatest(u.created_at, coalesce((select nullif(a.value, '')::timestamptz from public.app_settings a where a.key = 'trial_epoch'), '-infinity'::timestamptz))
    + make_interval(days => coalesce((select nullif(a.value, '')::integer from public.app_settings a where a.key = 'trial_days'), 14))
  from auth.users u where u.id = p_user;
$$;
revoke all on function public.trial_ends(uuid) from public, anon, authenticated;

create or replace function public.plan_of(p_user uuid) returns public.plans language sql stable security definer set search_path = '' as $$
  with pick as (select coalesce(
    (select s.plan_id from public.subscriptions s where s.user_id = p_user and s.status in ('active', 'trialing', 'past_due')),
    (select a.value from public.app_settings a where a.key = 'default_plan'),
    'beta') as id)
  select p.* from public.plans p
  where p.id = (select case when pick.id = 'trial' and coalesce(public.trial_ends(p_user) <= now(), false) then 'expired' else pick.id end from pick);
$$;

-- Limit messages: an ended trial says so (not "aren't part of the Free trial ended plan").
create or replace function public.plan_full(p_user uuid, p_used integer, p_what text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when (public.plan_of(p_user)).id = 'expired' then 'Your free trial has ended. Choose a plan in Your account to keep going.'
    when p_used = 0 then format('%s aren''t part of the %s plan. Choose a plan that includes them in Your account.',
      upper(left(p_what, 1)) || substr(p_what, 2), (public.plan_of(p_user)).name)
    else case (public.plan_of(p_user)).limits ->> 'window'
      when 'day' then format('You''ve used your %s %s for today. Try again tomorrow.', p_used, p_what)
      when 'ever' then format('The free trial includes %s %s. Choose a plan in Your account to keep going.', p_used, p_what)
      else format('You''ve used your %s %s for this month. They reset when your next month starts, or choose a bigger plan in Your account.', p_used, p_what)
    end
  end;
$$;
revoke all on function public.plan_full(uuid, integer, text) from public, anon, authenticated;

create or replace function public.plan_item_cap() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  k text := tg_argv[0];          -- 'flyers' | 'posts' | 'docs'
  allowed integer := public.plan_limit(new.user_id, k);
  n integer;
  what text := case k when 'flyers' then 'flyer' when 'posts' then 'post' else 'quote or invoice' end;
begin
  if (public.plan_of(new.user_id)).id = 'expired' then
    raise exception 'Your free trial has ended. Choose a plan in Your account to keep making things.';
  end if;
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

-- Read-only after the trial: saved work can't be changed (deleting still works).
create or replace function public.trial_lock() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (public.plan_of(new.user_id)).id = 'expired' then
    raise exception 'Your free trial has ended. Choose a plan in Your account to keep editing.';
  end if;
  return new;
end $$;
revoke all on function public.trial_lock() from public, anon, authenticated;
drop trigger if exists flyers_trial_lock on public.flyers;
create trigger flyers_trial_lock before update on public.flyers for each row execute function public.trial_lock();
drop trigger if exists posts_trial_lock on public.posts;
create trigger posts_trial_lock before update on public.posts for each row execute function public.trial_lock();
drop trigger if exists inv_docs_trial_lock on public.inv_docs;
create trigger inv_docs_trial_lock before update on public.inv_docs for each row execute function public.trial_lock();
drop trigger if exists menus_trial_lock on public.menus;
create trigger menus_trial_lock before insert or update on public.menus for each row execute function public.trial_lock();

-- my_plan: also when the trial ends (null on other plans).
create or replace function public.my_plan() returns json language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id), p as (select (public.plan_of((select id from me))).*), s as (
    select * from public.subscriptions where user_id = (select id from me))
  select json_build_object(
    'plan', (select row_to_json(p) from p),
    'billing', (select billing from s), 'status', (select status from s),
    'period_end', (select current_period_end from s),
    'requested_plan', (select requested_plan_id from s), 'requested_billing', (select requested_billing from s), 'requested_at', (select requested_at from s),
    'billing_managed', coalesce((select stripe_subscription_id is not null and status in ('active', 'trialing', 'past_due') from s), false),
    'trial_ends', case when (select id from p) in ('trial', 'expired') then public.trial_ends((select id from me)) end,
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
revoke all on function public.my_plan() from public, anon;
grant execute on function public.my_plan() to authenticated;
