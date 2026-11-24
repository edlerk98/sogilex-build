-- 033 (2026-11-24): fix. request_plan_change (021) saved a request by inserting a subscriptions row with the person's
-- CURRENT plan (e.g. 'beta') as active, which pinned them to it: at the launch switch (default_plan -> 'trial') they would
-- have kept Beta. A new row is now stored as 'canceled' (plan_of ignores it, so the account follows the default plan);
-- an existing row only gets the request added. Rows already pinned this way (no Stripe subscription, plan 'beta' or
-- 'trial') are set to 'canceled' too. Comp, team and Stripe rows are untouched. Safe to re-run.
create or replace function public.request_plan_change(p_plan text, p_billing text) returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'Sign in first.'; end if;
  if not exists (select 1 from public.plans p where p.id = p_plan and p.public) then raise exception 'That plan isn''t available.'; end if;
  if p_billing is not null and p_billing not in ('month', 'year') then raise exception 'Choose monthly or yearly.'; end if;
  insert into public.subscriptions (user_id, plan_id, status, requested_plan_id, requested_billing, requested_at)
  values (me, coalesce((select a.value from public.app_settings a where a.key = 'default_plan'), 'beta'), 'canceled', p_plan, p_billing, now())
  on conflict (user_id) do update set requested_plan_id = excluded.requested_plan_id, requested_billing = excluded.requested_billing,
    requested_at = now(), updated_at = now();
end $$;
revoke all on function public.request_plan_change(text, text) from public, anon;
grant execute on function public.request_plan_change(text, text) to authenticated;

update public.subscriptions set status = 'canceled', updated_at = now()
where stripe_subscription_id is null and plan_id in ('beta', 'trial') and status <> 'canceled';
