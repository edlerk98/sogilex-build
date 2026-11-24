-- 031 (2026-11-24): my_plan() also says whether the plan is paid through Stripe ('billing_managed'), so the account page
-- shows "Manage billing" (Stripe's page: card, switch plan, receipts, cancel) instead of "Change plan". Safe to re-run.
-- Same as 021's my_plan otherwise.
create or replace function public.my_plan() returns json language sql stable security definer set search_path = '' as $$
  with me as (select auth.uid() as id), p as (select (public.plan_of((select id from me))).*), s as (
    select * from public.subscriptions where user_id = (select id from me))
  select json_build_object(
    'plan', (select row_to_json(p) from p),
    'billing', (select billing from s), 'status', (select status from s),
    'period_end', (select current_period_end from s),
    'requested_plan', (select requested_plan_id from s), 'requested_billing', (select requested_billing from s), 'requested_at', (select requested_at from s),
    'billing_managed', coalesce((select stripe_subscription_id is not null and status in ('active', 'trialing', 'past_due') from s), false),
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
