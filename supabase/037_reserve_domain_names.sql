-- 037 (2026-11-24): own web addresses (Cloudflare for SaaS). domains.sogilex.net is the fallback origin and the address
-- customers point www at, so it (and a few names like it) can't be anyone's site name. Safe to re-run.
create or replace function public.slug_reserved(s text) returns boolean language sql immutable set search_path = '' as $$
  select s = any (array['www','api','admin','app','mail','email','smtp','imap','pop','ftp','ns1','ns2','cdn','static','assets',
    'build','atlas','sogilex','support','help','status','blog','docs','dev','test','staging','login','signin','signup',
    'account','accounts','billing','pay','payments','abuse','security','root','owner','official','sites','site','www1',
    'domains','domain','fallback','customers','connect','origin','proxy','cname','dns','ssl']);
$$;
