-- 030 (2026-11-24): the "Basics" plan, $9/month or $90/year (owner approved the advisor's suggestion). Safe to re-run.
-- For people who only need flyers, posts, printed menus and quotes/invoices: every one of those tools, the same saved-item
-- room as Do it yourself, fewer AI extras (15 captions, 3 menus read from photos a month), and NO website builder,
-- website changes, publishing or online menu (those are what Do it yourself's $19 pays for: hosting and the AI builds).
-- Limits are cut by scope and amount, never by making the output look worse (no watermarks, every look available).
-- Not on the public Plans page until payments work (same as Do it yourself).
insert into public.plans (id, name, blurb, month_cents, year_cents, setup_cents, can_publish, limits, public, sort)
values ('basics', 'Basics', 'Flyers, social posts, printed menus, quotes and invoices. No website.', 900, 9000, 0, false,
  '{"docs":2000,"edits":0,"posts":100,"builds":0,"flyers":40,"window":"month","imports":3,"captions":15}'::jsonb, true, 15)
on conflict (id) do update set name = excluded.name, blurb = excluded.blurb, month_cents = excluded.month_cents,
  year_cents = excluded.year_cents, setup_cents = excluded.setup_cents, can_publish = excluded.can_publish,
  limits = excluded.limits, public = excluded.public, sort = excluded.sort;

-- A plan that doesn't include something says so, instead of "You've used your 0 website builds for this month".
create or replace function public.plan_full(p_user uuid, p_used integer, p_what text) returns text
language sql stable security definer set search_path = '' as $$
  select case
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
