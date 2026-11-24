-- 029 (2026-11-24): a hidden "Complimentary" plan for people the owner gives full access for free (family, friends,
-- early helpers). Safe to re-run.
-- Same tools and limits as Beta today (every tool, daily limits, publishing), but it's a person's own plan, so it is NOT
-- affected when app_settings.default_plan switches from 'beta' to 'trial' at launch.
-- Giving it to someone: Table Editor -> subscriptions -> insert a row (user_id, plan_id 'comp', status 'active', no
-- billing, no period dates, no Stripe ids). User ids are never written in this public repo.
-- FOR THE STRIPE WORK: the webhook must only change subscription rows that have a stripe_subscription_id, so it can never
-- move a complimentary (or team) account to another plan.
insert into public.plans (id, name, blurb, month_cents, year_cents, setup_cents, can_publish, limits, public, sort)
values ('comp', 'Complimentary', 'Full access, on the house.', 0, null, 0, true,
  '{"docs":2000,"edits":30,"posts":100,"builds":3,"flyers":40,"window":"day","imports":10,"captions":40}'::jsonb, false, 80)
on conflict (id) do update set name = excluded.name, blurb = excluded.blurb, month_cents = excluded.month_cents,
  year_cents = excluded.year_cents, setup_cents = excluded.setup_cents, can_publish = excluded.can_publish,
  limits = excluded.limits, public = excluded.public, sort = excluded.sort;
