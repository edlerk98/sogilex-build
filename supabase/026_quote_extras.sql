-- 026 (2026-11-23): quote extras. Safe to re-run. Requires 018_invoices.sql.
--
-- New in inv_docs.data (all optional; older documents read the same as before):
--   lines[].o  true = an optional add-on (quotes only). Listed apart on the quote and NOT in its subtotal, tax or total.
--   intro      an opening message on a quote (at most 1000 characters).
--   showTerms  false = leave the business's saved quote terms off this quote (default: print them).
--   sign       false = no "Accepted by" signature block (default: print it on quotes).
-- The saved quote terms live in inv_profile.data.quoteTerms; inv_send already freezes the business details (including
-- them) onto a quote when it's sent, so a sent quote keeps the terms it was sent with.
--
-- inv_quote_to_invoice gets an optional 4th argument: which add-ons the customer chose (their positions in the quote's
-- lines, counting from 0). Chosen add-ons become ordinary lines on the invoice; the others are left off.

create or replace function public.inv_docs_check() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ln jsonb;
  q numeric; p numeric; amt bigint;
  sub bigint := 0; taxable bigint := 0;
  rate numeric;
  n integer := 0;
  regular integer := 0;
begin
  if tg_op = 'INSERT' then
    if (select count(*) from public.inv_docs x where x.user_id = new.user_id) >= 2000 then
      raise exception 'You have 2000 quotes and invoices saved. Delete old drafts to make room.';
    end if;
    -- Whatever was sent, a new document starts as a draft with no number.
    new.status := 'draft'; new.number := null; new.sent_at := null; new.paid_on := null; new.closed_at := null;
    new.created_at := now();
  else
    if new.user_id is distinct from old.user_id or new.kind is distinct from old.kind or new.created_at is distinct from old.created_at then
      raise exception 'That can''t be changed.';
    end if;
    -- Sent, paid, cancelled, accepted or declined: the words and numbers are final.
    if old.status <> 'draft' and (new.data is distinct from old.data or new.customer_id is distinct from old.customer_id
        or new.source_id is distinct from old.source_id) then
      raise exception 'This % has been sent, so it can''t be changed. Make a copy to change it.', old.kind;
    end if;
  end if;

  if jsonb_typeof(new.data) <> 'object' then raise exception 'Something went wrong saving this. Refresh and try again.'; end if;
  if new.data ? 'lines' and jsonb_typeof(new.data -> 'lines') <> 'array' then raise exception 'Something went wrong saving the lines.'; end if;
  if length(coalesce(new.data ->> 'intro', '')) > 1000 then raise exception 'The opening message is too long (1000 characters at most).'; end if;

  for ln in select value from jsonb_array_elements(coalesce(new.data -> 'lines', '[]'::jsonb)) loop
    n := n + 1;
    if n > 100 then raise exception 'A quote or invoice can have at most 100 lines.'; end if;
    if jsonb_typeof(ln) <> 'object' then raise exception 'Line % isn''t valid.', n; end if;
    q := case when jsonb_typeof(ln -> 'q') = 'number' then (ln ->> 'q')::numeric else 0 end;
    p := case when jsonb_typeof(ln -> 'p') = 'number' then (ln ->> 'p')::numeric else 0 end;
    if q <> trunc(q) or q < 0 or q > 10000000 then raise exception 'Line %: the quantity must be between 0 and 100,000, with at most 2 decimals.', n; end if;
    if p <> trunc(p) or abs(p) > 100000000 then raise exception 'Line %: the price must be under $1,000,000, in dollars and cents.', n; end if;
    if length(coalesce(ln ->> 'd', '')) > 500 then raise exception 'Line %: the description is too long (500 characters at most).', n; end if;
    if ln ? 'o' and jsonb_typeof(ln -> 'o') <> 'boolean' then raise exception 'Line % isn''t valid.', n; end if;
    if (ln ->> 'o') = 'true' then
      -- An optional add-on: shown on the quote, not counted in its total.
      if new.kind = 'invoice' then raise exception 'Optional add-ons are for quotes. On an invoice, every line is billed.'; end if;
      continue;
    end if;
    regular := regular + 1;
    amt := public.inv_div_round(q * p, 100);
    sub := sub + amt;
    if coalesce(ln ->> 't', 'true') <> 'false' then taxable := taxable + amt; end if;
  end loop;

  rate := case when jsonb_typeof(new.data -> 'tax') = 'number' then (new.data ->> 'tax')::numeric else 0 end;
  if rate <> trunc(rate) or rate < 0 or rate > 30000 then raise exception 'The tax rate must be between 0%% and 30%%, with at most 3 decimals.'; end if;

  new.subtotal_cents := sub;
  new.tax_cents := public.inv_div_round(taxable * rate, 100000);
  new.total_cents := sub + new.tax_cents;
  new.issue_date := case when (new.data ->> 'date') ~ '^\d{4}-\d{2}-\d{2}$' then (new.data ->> 'date')::date else null end;
  new.due_date := case when (new.data ->> 'due') ~ '^\d{4}-\d{2}-\d{2}$' then (new.data ->> 'due')::date else null end;
  new.updated_at := now();
  return new;
exception when datetime_field_overflow or invalid_datetime_format then
  raise exception 'One of the dates isn''t a real date.';
end $$;
revoke all on function public.inv_docs_check() from public, anon, authenticated;

-- A quote must have at least one line that isn't optional before it can be sent (otherwise its total is $0.00).
create or replace function public.inv_send_check() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'draft' and new.status = 'sent' and new.kind = 'quote'
     and not exists (select 1 from jsonb_array_elements(coalesce(new.data -> 'lines', '[]'::jsonb)) l where coalesce(l ->> 'o', 'false') <> 'true') then
    raise exception 'Add at least one line that isn''t an optional add-on first.';
  end if;
  return new;
end $$;
revoke all on function public.inv_send_check() from public, anon, authenticated;
drop trigger if exists inv_send_check on public.inv_docs;
create trigger inv_send_check before update of status on public.inv_docs for each row execute function public.inv_send_check();

drop function if exists public.inv_quote_to_invoice(uuid, date, date);
create or replace function public.inv_quote_to_invoice(p_id uuid, p_date date, p_due date, p_addons integer[] default null)
returns public.inv_docs language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  q public.inv_docs;
  inv public.inv_docs;
  lines jsonb;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select * into q from public.inv_docs where id = p_id and user_id = me and kind = 'quote' for update;
  if not found then raise exception 'That quote wasn''t found.'; end if;
  if q.status not in ('sent', 'accepted') then raise exception 'Mark the quote as sent first.'; end if;
  -- Ordinary lines always; an optional add-on only if the customer chose it (it then becomes an ordinary line).
  select coalesce(jsonb_agg(case when (l.value ->> 'o') = 'true' then l.value - 'o' else l.value end order by l.ord), '[]'::jsonb)
    into lines
    from jsonb_array_elements(coalesce(q.data -> 'lines', '[]'::jsonb)) with ordinality as l(value, ord)
   where coalesce(l.value ->> 'o', 'false') <> 'true' or (l.ord - 1)::integer = any (coalesce(p_addons, '{}'::integer[]));
  insert into public.inv_docs (user_id, kind, customer_id, source_id, data)
  values (me, 'invoice', q.customer_id, q.id,
    jsonb_build_object('v', 1, 'date', p_date::text, 'due', p_due::text,
      'to', coalesce(q.data -> 'to', '{}'::jsonb), 'lines', lines,
      'tax', coalesce(q.data -> 'tax', '0'::jsonb), 'notes', coalesce(q.data -> 'notes', '""'::jsonb),
      'look', coalesce(q.data -> 'look', '{}'::jsonb)))
  returning * into inv;
  if q.status = 'sent' then
    update public.inv_docs set status = 'accepted', closed_at = now() where id = q.id;
  end if;
  return inv;
end $$;
revoke all on function public.inv_quote_to_invoice(uuid, date, date, integer[]) from public, anon;
grant execute on function public.inv_quote_to_invoice(uuid, date, date, integer[]) to authenticated;
