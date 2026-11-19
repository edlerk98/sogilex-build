-- Sogilex Build: reopen your sites. Every finished build is already kept in build_outputs (for publishing);
-- these let the owner list and load their own, so a site isn't lost when the tab closes.
-- Safe to re-run. The table itself stays closed to the browser: only these two functions read it, and only
-- the signed-in person's own rows.

create or replace function public.my_builds()
returns table (build_id uuid, created_at timestamptz, title text, kb integer, live boolean)
language sql stable security definer set search_path = '' as $$
  select o.build_id,
         o.created_at,
         left(btrim(regexp_replace(coalesce(substring(o.html from '(?i)<title[^>]*>(.*?)</title>'), ''), '\s+', ' ', 'g')), 80),
         (octet_length(o.html) / 1024)::integer,
         exists (select 1 from public.sites x where x.user_id = o.user_id and x.build_id = o.build_id)
  from public.build_outputs o
  where o.user_id = auth.uid()
  order by o.created_at desc
  limit 50;
$$;

create or replace function public.my_build(p_build_id uuid)
returns text
language sql stable security definer set search_path = '' as $$
  select o.html from public.build_outputs o where o.build_id = p_build_id and o.user_id = auth.uid();
$$;

revoke all on function public.my_builds() from public, anon;
revoke all on function public.my_build(uuid) from public, anon;
grant execute on function public.my_builds() to authenticated;
grant execute on function public.my_build(uuid) to authenticated;
