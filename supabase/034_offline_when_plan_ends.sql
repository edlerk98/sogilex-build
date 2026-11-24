-- 034 (2026-11-24): a published site or online menu is only shown while its owner's plan includes publishing.
-- When a plan ends (Stripe 'canceled' -> back to the default plan) or the default becomes the free trial, the Worker
-- shows "not available right now" instead. Nothing is deleted: choosing a plan again brings it straight back, with no
-- republishing, and the files stay downloadable in Build. Safe to re-run.
--   site_live(slug): asked by the Worker (anyone may ask; it only says yes or no). Past-due plans still count as live
--   (Stripe retries the card for a while first).
create or replace function public.site_live(p_slug text) returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.sites x where x.slug = lower(p_slug) and public.can_publish(x.user_id));
$$;
revoke all on function public.site_live(text) from public;
grant execute on function public.site_live(text) to anon, authenticated;

-- The online menu: same rule, in the function the Worker already calls.
create or replace function public.public_menu(p_slug text) returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('data', m.data,
    'logo', coalesce(k.menu_logo, k.logo),
    'colors', case when k.menu_logo is not null then coalesce(k.menu_colors, '[]'::jsonb) else coalesce(k.colors, '[]'::jsonb) end)
  from public.online_menus m left join public.brand_kits k on k.user_id = m.user_id
  where m.slug = lower(p_slug) and public.can_publish(m.user_id);
$$;
