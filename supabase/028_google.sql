-- 028 (2026-11-24): "Show up on Google" for published sites. Safe to re-run.
-- publish_site also returns the owner's saved business hours (025), so the Worker can add them to the site's
-- schema.org data for Google. The Worker uses them only when every time in them is shown on the page itself.
-- Same function as 025 otherwise (same arguments, so grants are kept; repeated below anyway).

create or replace function public.publish_site(p_build_id uuid, p_slug text, p_preview text default null) returns json language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  s text := lower(trim(p_slug));
  pv text := lower(trim(coalesce(p_preview, '')));
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
  -- No choice sent (an older page or Worker): keep the saved one.
  if pv = '' then pv := coalesce((select x.preview from public.sites x where x.user_id = me), 'auto'); end if;
  if pv not in ('auto', 'logo') then
    if pv !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.site_photos p where p.id = pv::uuid and p.user_id = me) then
      raise exception 'That link preview photo isn''t in your photos any more. Choose another.';
    end if;
  end if;
  select o.html into out_html from public.build_outputs o where o.build_id = p_build_id and o.user_id = me;
  if out_html is null then raise exception 'That build isn''t available to publish. Build the site again, then publish.'; end if;
  perform pg_advisory_xact_lock(hashtext('sogilex_sites'));
  if exists (select 1 from public.sites x where x.slug = s and x.user_id <> me)
     or exists (select 1 from public.online_menus m where m.slug = s and m.user_id <> me) then
    raise exception 'That name is taken. Try another.';
  end if;
  select x.slug into old from public.sites x where x.user_id = me;
  insert into public.sites (user_id, slug, build_id, published_at, preview) values (me, s, p_build_id, now(), pv)
  on conflict (user_id) do update set slug = excluded.slug, build_id = excluded.build_id, published_at = now(), preview = excluded.preview;
  return json_build_object('slug', s, 'html', out_html, 'old_slug', case when old is distinct from s then old end,
    'logo', (select k.logo from public.brand_kits k where k.user_id = me), 'preview', pv,
    'hours', (select h.hours from public.business_hours h where h.user_id = me));
end $$;

revoke all on function public.publish_site(uuid, text, text) from public, anon;
grant execute on function public.publish_site(uuid, text, text) to authenticated;
