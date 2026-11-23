-- 027 (2026-11-23): contact-form spam fix (security review item 1). Safe to re-run.
--
-- Before: the Worker stored contact-form messages by calling submit_site_message with the public (publishable) key,
-- so anyone could call it directly, skip the site, and change p_ip_hash on every call to dodge the 5-per-visitor
-- limit (only the 30-per-site-per-hour cap held).
-- Now: the Worker also sends a secret (Cloudflare secret FORM_SECRET, never in code or in this repo). The database
-- keeps only its SHA-256 fingerprint, in app_settings 'form_secret_sha256' (no client can read app_settings).
-- While that row is missing, the function works as before (so the Worker can be deployed first); once it's there,
-- calls without the right secret are refused. Undo: delete that row.
-- To change the secret: set a new FORM_SECRET on the Worker and store the new fingerprint (same order as above).

drop function if exists public.submit_site_message(text, jsonb, text);
create or replace function public.submit_site_message(p_slug text, p_fields jsonb, p_ip_hash text, p_secret text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  owner uuid;
  want text := (select a.value from public.app_settings a where a.key = 'form_secret_sha256');
begin
  if want is not null and (p_secret is null or encode(sha256(convert_to(p_secret, 'UTF8')), 'hex') <> want) then
    raise exception 'Messages can only be sent from the site''s own contact form.' using errcode = '42501';
  end if;
  select x.user_id into owner from public.sites x where x.slug = lower(p_slug);
  if owner is null then return false; end if;
  if jsonb_typeof(p_fields) <> 'object' or pg_column_size(p_fields) > 12000 then return false; end if;
  if (select count(*) from public.site_messages m where m.slug = lower(p_slug) and m.created_at > now() - interval '1 hour') >= 30 then return false; end if;
  if p_ip_hash is not null and (select count(*) from public.site_messages m where m.ip_hash = p_ip_hash and m.created_at > now() - interval '1 hour') >= 5 then return false; end if;
  insert into public.site_messages (user_id, slug, fields, ip_hash) values (owner, lower(p_slug), p_fields, left(p_ip_hash, 64));
  return true;
end $$;
revoke all on function public.submit_site_message(text, jsonb, text, text) from public;
grant execute on function public.submit_site_message(text, jsonb, text, text) to anon, authenticated;
