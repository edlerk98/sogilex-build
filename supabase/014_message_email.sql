-- Email new contact-form messages to the site owner (2026-11-19). Safe to re-run. Needs 004 (site_messages).
-- The owner picks an address in Build. Their own sign-in address works at once; any other address must be confirmed
-- from that inbox first (so nobody can point message emails at a stranger). Every email has a one-click "stop" link.
-- Sending happens in the Edge Function message-email (Resend, secret RESEND_API_KEY). The database asks for it right
-- after a message is saved (pg_net), and the function only sends messages that are fresh and not sent yet.

create extension if not exists pg_net with schema extensions;

create table if not exists public.message_emails (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text not null check (char_length(email) <= 254 and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  confirmed_at timestamptz,
  token uuid not null default gen_random_uuid(),       -- in the confirm link (until confirmed) and the stop link
  sent_count int not null default 0,                    -- confirmation emails sent in the current hour
  sent_window timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.message_emails enable row level security;
drop policy if exists "message_emails: read own" on public.message_emails;
create policy "message_emails: read own" on public.message_emails for select to authenticated using (user_id = (select auth.uid()));
revoke all on public.message_emails from anon, authenticated;
grant select (user_id, email, confirmed_at, updated_at) on public.message_emails to authenticated;

alter table public.site_messages add column if not exists emailed_at timestamptz;

create or replace function public.site_message_email() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.message_emails e where e.user_id = new.user_id and e.confirmed_at is not null) then
    perform net.http_post(
      url := 'https://sdltqbctuieyjlujsdhj.supabase.co/functions/v1/message-email',
      body := jsonb_build_object('action', 'message', 'id', new.id),
      headers := '{"Content-Type": "application/json"}'::jsonb,
      timeout_milliseconds := 10000);
  end if;
  return new;
end $$;
revoke all on function public.site_message_email() from public, anon, authenticated;
drop trigger if exists site_message_email on public.site_messages;
create trigger site_message_email after insert on public.site_messages for each row execute function public.site_message_email();

-- The Edge Function uses the service role; in this project new tables don't grant it anything by default.
grant select, insert, update, delete on public.message_emails to service_role;
grant select, update on public.site_messages to service_role;
