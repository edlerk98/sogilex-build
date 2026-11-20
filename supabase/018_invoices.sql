-- Sogilex Quotes & invoices (beta). Safe to re-run. No AI: plain arithmetic in whole cents.
--
-- Rules that make it work like real bookkeeping:
--   * A draft has no number. Marking it sent (inv_send) gives it the next number for its kind, with no gaps:
--     the counter only moves inside the same transaction that marks the document sent.
--   * A sent quote or invoice can't be edited or deleted. An invoice can be cancelled (status 'void'), which keeps
--     its number. Mistakes are fixed by voiding and making a corrected copy.
--   * Totals are worked out here from the lines (the page shows the same maths), so a stored total is never stale.
--   * "Overdue" isn't stored: it's a sent invoice whose due date has passed (the page works it out).
--
-- data (jsonb) on inv_docs:
--   { v, date: 'YYYY-MM-DD', due: 'YYYY-MM-DD' (invoice: due date, quote: valid until),
--     to: { name, email, phone, address }, lines: [ { d: text, q: quantity in hundredths, p: unit price in cents,
--     t: taxable (bool, default true) } ], tax: rate in thousandths of a percent (8475 = 8.475%), notes, from: {...}
--     (copied from the business details when sent), look: { accent } }

-- ---------- business details (one row a person) ----------
create table if not exists public.inv_profile (
  user_id uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 20000),
  updated_at timestamptz not null default now()
);
alter table public.inv_profile enable row level security;
drop policy if exists "inv_profile: own" on public.inv_profile;
create policy "inv_profile: own" on public.inv_profile for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.inv_profile from anon, authenticated;
grant select, insert, update on public.inv_profile to authenticated;

-- ---------- saved customers ----------
create table if not exists public.inv_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  email text not null default '' check (length(email) <= 200),
  phone text not null default '' check (length(phone) <= 60),
  address text not null default '' check (length(address) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists inv_customers_user_idx on public.inv_customers (user_id, name);
alter table public.inv_customers enable row level security;
drop policy if exists "inv_customers: own" on public.inv_customers;
create policy "inv_customers: own" on public.inv_customers for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
revoke all on public.inv_customers from anon, authenticated;
grant select, insert, update, delete on public.inv_customers to authenticated;

create or replace function public.inv_customers_cap() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if (select count(*) from public.inv_customers c where c.user_id = new.user_id) >= 500 then
    raise exception 'You have 500 customers saved. Delete one you no longer need to add another.';
  end if;
  return new;
end $$;
revoke all on function public.inv_customers_cap() from public, anon, authenticated;
drop trigger if exists inv_customers_cap on public.inv_customers;
create trigger inv_customers_cap before insert on public.inv_customers for each row execute function public.inv_customers_cap();

-- ---------- quotes and invoices ----------
create table if not exists public.inv_docs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  kind text not null check (kind in ('quote', 'invoice')),
  status text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'void', 'accepted', 'declined')),
  number integer check (number > 0),
  customer_id uuid references public.inv_customers (id) on delete set null,
  source_id uuid references public.inv_docs (id) on delete set null, -- the quote (or invoice) it was made from
  data jsonb not null default '{}'::jsonb check (pg_column_size(data) < 100000),
  issue_date date,
  due_date date,
  subtotal_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  total_cents bigint not null default 0,
  sent_at timestamptz,
  paid_on date,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, kind, number),
  check ((status = 'draft') = (number is null)),
  check (kind = 'invoice' or status in ('draft', 'sent', 'accepted', 'declined')),
  check (kind = 'quote' or status in ('draft', 'sent', 'paid', 'void'))
);
create index if not exists inv_docs_user_idx on public.inv_docs (user_id, updated_at desc);
alter table public.inv_docs enable row level security;
drop policy if exists "inv_docs: read own" on public.inv_docs;
drop policy if exists "inv_docs: insert own" on public.inv_docs;
drop policy if exists "inv_docs: update own" on public.inv_docs;
drop policy if exists "inv_docs: delete own drafts" on public.inv_docs;
create policy "inv_docs: read own" on public.inv_docs for select to authenticated using (user_id = (select auth.uid()));
create policy "inv_docs: insert own" on public.inv_docs for insert to authenticated with check (user_id = (select auth.uid()));
create policy "inv_docs: update own" on public.inv_docs for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy "inv_docs: delete own drafts" on public.inv_docs for delete to authenticated
  using (user_id = (select auth.uid()) and status = 'draft');
revoke all on public.inv_docs from anon, authenticated;
grant select, delete on public.inv_docs to authenticated;
-- The page may only write the words and numbers; status, number and dates move only through the functions below.
grant insert (kind, data, customer_id, source_id) on public.inv_docs to authenticated;
grant update (data, customer_id, updated_at) on public.inv_docs to authenticated;

-- One counter per person and kind. No direct access: only inv_send moves it.
create table if not exists public.inv_counters (
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('quote', 'invoice')),
  last integer not null default 0,
  primary key (user_id, kind)
);
alter table public.inv_counters enable row level security;
revoke all on public.inv_counters from anon, authenticated;

-- Rounds n / d to the nearest whole number, halves away from zero (the usual rule for money).
create or replace function public.inv_div_round(n numeric, d numeric) returns bigint language sql immutable set search_path = '' as $$
  select round(n / d)::bigint;
$$;

-- Checks the lines and works out the totals; keeps dates in columns for sorting and "overdue".
create or replace function public.inv_docs_check() returns trigger language plpgsql security definer set search_path = '' as $$
declare
  ln jsonb;
  q numeric; p numeric; amt bigint;
  sub bigint := 0; taxable bigint := 0;
  rate numeric;
  n integer := 0;
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

  for ln in select value from jsonb_array_elements(coalesce(new.data -> 'lines', '[]'::jsonb)) loop
    n := n + 1;
    if n > 100 then raise exception 'A quote or invoice can have at most 100 lines.'; end if;
    if jsonb_typeof(ln) <> 'object' then raise exception 'Line % isn''t valid.', n; end if;
    q := case when jsonb_typeof(ln -> 'q') = 'number' then (ln ->> 'q')::numeric else 0 end;
    p := case when jsonb_typeof(ln -> 'p') = 'number' then (ln ->> 'p')::numeric else 0 end;
    if q <> trunc(q) or q < 0 or q > 10000000 then raise exception 'Line %: the quantity must be between 0 and 100,000, with at most 2 decimals.', n; end if;
    if p <> trunc(p) or abs(p) > 100000000 then raise exception 'Line %: the price must be under $1,000,000, in dollars and cents.', n; end if;
    if length(coalesce(ln ->> 'd', '')) > 500 then raise exception 'Line %: the description is too long (500 characters at most).', n; end if;
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
drop trigger if exists inv_docs_check on public.inv_docs;
create trigger inv_docs_check before insert or update on public.inv_docs for each row execute function public.inv_docs_check();

-- ---------- actions ----------
-- Mark a draft as sent: gives it the next number, freezes the business details and the customer's details on it,
-- and keeps the saved customer list up to date (adds the customer if they're new).
create or replace function public.inv_send(p_id uuid) returns public.inv_docs language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  d public.inv_docs;
  nextn integer;
  prof jsonb;
  cust uuid;
  t jsonb;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select * into d from public.inv_docs where id = p_id and user_id = me for update;
  if not found then raise exception 'That quote or invoice wasn''t found.'; end if;
  if d.status <> 'draft' then raise exception 'This % has already been sent.', d.kind; end if;
  t := coalesce(d.data -> 'to', '{}'::jsonb);
  if btrim(coalesce(t ->> 'name', '')) = '' then raise exception 'Add who it''s for (the customer''s name) first.'; end if;
  if jsonb_array_length(coalesce(d.data -> 'lines', '[]'::jsonb)) = 0 then raise exception 'Add at least one line first.'; end if;
  if d.issue_date is null then raise exception 'Add the date first.'; end if;

  select data into prof from public.inv_profile where user_id = me;
  -- The customer list: update the linked customer, or add a new one (unless 500 are already saved).
  cust := d.customer_id;
  if cust is not null then
    update public.inv_customers set name = left(btrim(t ->> 'name'), 120), email = left(coalesce(t ->> 'email', ''), 200),
      phone = left(coalesce(t ->> 'phone', ''), 60), address = left(coalesce(t ->> 'address', ''), 400), updated_at = now()
     where id = cust and user_id = me;
    if not found then cust := null; end if;
  end if;
  if cust is null and (select count(*) from public.inv_customers where user_id = me) < 500 then
    select id into cust from public.inv_customers where user_id = me and lower(name) = lower(btrim(t ->> 'name')) limit 1;
    if cust is null then
      insert into public.inv_customers (user_id, name, email, phone, address)
      values (me, left(btrim(t ->> 'name'), 120), left(coalesce(t ->> 'email', ''), 200), left(coalesce(t ->> 'phone', ''), 60), left(coalesce(t ->> 'address', ''), 400))
      returning id into cust;
    end if;
  end if;

  insert into public.inv_counters (user_id, kind, last) values (me, d.kind, 1)
  on conflict (user_id, kind) do update set last = public.inv_counters.last + 1
  returning last into nextn;

  update public.inv_docs
     set status = 'sent', number = nextn, sent_at = now(), customer_id = cust,
         data = jsonb_set(data, '{from}', coalesce(prof, '{}'::jsonb) - 'terms' - 'taxDefault')
   where id = p_id
  returning * into d;
  return d;
end $$;

-- Paid / not paid / cancelled for invoices; accepted / declined / back to sent for quotes.
create or replace function public.inv_set_status(p_id uuid, p_status text, p_paid_on date default null)
returns public.inv_docs language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  d public.inv_docs;
  ok boolean;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select * into d from public.inv_docs where id = p_id and user_id = me for update;
  if not found then raise exception 'That quote or invoice wasn''t found.'; end if;
  ok := case
    when d.kind = 'invoice' then (d.status, p_status) in (('sent', 'paid'), ('paid', 'sent'), ('sent', 'void'))
    else (d.status, p_status) in (('sent', 'accepted'), ('sent', 'declined'), ('accepted', 'sent'), ('declined', 'sent'))
  end;
  if not ok then raise exception 'This % is marked %, so it can''t be marked %.', d.kind, d.status, p_status; end if;
  update public.inv_docs
     set status = p_status,
         paid_on = case when p_status = 'paid' then coalesce(p_paid_on, current_date) else null end,
         closed_at = case when p_status = 'sent' then null else now() end
   where id = p_id
  returning * into d;
  return d;
end $$;

-- Turn a sent (or accepted) quote into a draft invoice with the same customer, lines, tax and notes, and mark the
-- quote accepted. Dates come from the page (the person's own calendar day, not the server's).
create or replace function public.inv_quote_to_invoice(p_id uuid, p_date date, p_due date)
returns public.inv_docs language plpgsql security definer set search_path = '' as $$
declare
  me uuid := auth.uid();
  q public.inv_docs;
  inv public.inv_docs;
begin
  if me is null then raise exception 'Sign in first.'; end if;
  select * into q from public.inv_docs where id = p_id and user_id = me and kind = 'quote' for update;
  if not found then raise exception 'That quote wasn''t found.'; end if;
  if q.status not in ('sent', 'accepted') then raise exception 'Mark the quote as sent first.'; end if;
  insert into public.inv_docs (user_id, kind, customer_id, source_id, data)
  values (me, 'invoice', q.customer_id, q.id,
    jsonb_build_object('v', 1, 'date', p_date::text, 'due', p_due::text,
      'to', coalesce(q.data -> 'to', '{}'::jsonb), 'lines', coalesce(q.data -> 'lines', '[]'::jsonb),
      'tax', coalesce(q.data -> 'tax', '0'::jsonb), 'notes', coalesce(q.data -> 'notes', '""'::jsonb),
      'look', coalesce(q.data -> 'look', '{}'::jsonb)))
  returning * into inv;
  if q.status = 'sent' then
    update public.inv_docs set status = 'accepted', closed_at = now() where id = q.id;
  end if;
  return inv;
end $$;

revoke all on function public.inv_div_round(numeric, numeric) from public, anon;
revoke all on function public.inv_send(uuid) from public, anon;
revoke all on function public.inv_set_status(uuid, text, date) from public, anon;
revoke all on function public.inv_quote_to_invoice(uuid, date, date) from public, anon;
grant execute on function public.inv_send(uuid) to authenticated;
grant execute on function public.inv_set_status(uuid, text, date) to authenticated;
grant execute on function public.inv_quote_to_invoice(uuid, date, date) to authenticated;
