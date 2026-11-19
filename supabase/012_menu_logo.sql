-- Sogilex Menus: an optional logo for the menu only. By default Menus uses the account's logo (shared with the
-- website); an owner can choose a different one for their menu. Safe to re-run. Needs 006 and 011.

alter table public.brand_kits add column if not exists menu_logo text
  check (menu_logo is null or (menu_logo like 'data:image/png;base64,%' and char_length(menu_logo) <= 400000));
alter table public.brand_kits add column if not exists menu_logo_name text check (menu_logo_name is null or char_length(menu_logo_name) <= 120);
alter table public.brand_kits add column if not exists menu_colors jsonb not null default '[]'::jsonb
  check (jsonb_typeof(menu_colors) = 'array' and jsonb_array_length(menu_colors) <= 6);

-- The online menu shows the menu's own logo if there is one, otherwise the shared one.
create or replace function public.public_menu(p_slug text)
returns json language sql stable security definer set search_path = '' as $$
  select json_build_object('data', m.data,
    'logo', coalesce(k.menu_logo, k.logo),
    'colors', case when k.menu_logo is not null then coalesce(k.menu_colors, '[]'::jsonb) else coalesce(k.colors, '[]'::jsonb) end)
  from public.online_menus m left join public.brand_kits k on k.user_id = m.user_id
  where m.slug = lower(p_slug);
$$;
revoke all on function public.public_menu(text) from public;
grant execute on function public.public_menu(text) to anon, authenticated;
