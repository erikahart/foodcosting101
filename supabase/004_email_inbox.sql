-- Emailed invoices: attachments forwarded from Gmail (through Postmark) wait here until the app reads them.
-- Run once: Supabase > SQL Editor > New query > paste all of this > Run. Safe to run again.
-- Needs 003_gfs_feed.sql first (it uses the same on/off switch, source 'email').

do $$ begin
  if to_regclass('public.feed_config') is null then
    raise exception 'Run supabase/003_gfs_feed.sql first (in the project your app uses), then this file.';
  end if;
end $$;

create table if not exists inbound_mail (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts(id) on delete cascade,
  received_at timestamptz not null default now(),
  from_addr   text,
  from_name   text,
  subject     text,
  kind        text not null,                 -- 'attachment', 'confirmation' (Gmail forwarding code), 'note' (email with nothing usable)
  filename    text,
  content_type text,
  size        integer,
  data        text,                          -- base64; cleared once read
  info        jsonb,                         -- e.g. {"code": "...", "link": "..."} for Gmail confirmations
  status      text not null default 'waiting',  -- 'waiting', 'done', 'error', 'ignored'
  message     text,
  handled_at  timestamptz
);
create index if not exists inbound_mail_account on inbound_mail (account_id, received_at desc);
alter table inbound_mail enable row level security;   -- no policies: functions only

-- ---------- server only (secret key): the email webhook stores what arrived ----------
create or replace function inbound_add(p_account uuid, p_rows jsonb) returns integer
language plpgsql security definer set search_path = public as $$
declare r jsonb; n integer := 0;
begin
  for r in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    insert into inbound_mail (account_id, from_addr, from_name, subject, kind, filename, content_type, size, data, info, status, message)
    values (p_account, left(r->>'from_addr', 200), left(r->>'from_name', 200), left(r->>'subject', 300), coalesce(r->>'kind', 'attachment'),
            left(r->>'filename', 200), left(r->>'content_type', 100), (r->>'size')::int, r->>'data', r->'info',
            coalesce(r->>'status', 'waiting'), left(r->>'message', 300));
    n := n + 1;
  end loop;
  -- Keep the table small: drop file contents of anything handled more than 30 days ago.
  update inbound_mail set data = null where account_id = p_account and status <> 'waiting' and handled_at < now() - interval '30 days' and data is not null;
  return n;
end $$;

-- ---------- for people in the app ----------
-- Attachments waiting to be read (with their contents).
create or replace function inbound_waiting(p_account uuid) returns table (id uuid, received_at timestamptz, from_addr text, from_name text, subject text, filename text, content_type text, data text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  return query select m.id, m.received_at, m.from_addr, m.from_name, m.subject, m.filename, m.content_type, m.data
    from inbound_mail m where m.account_id = p_account and m.kind = 'attachment' and m.status = 'waiting' order by m.received_at limit 25;
end $$;

-- Recent activity for the panel (no file contents).
create or replace function inbound_recent(p_account uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare rows jsonb;
begin
  perform _require_member(p_account);
  select coalesce(jsonb_agg(to_jsonb(x) order by x.received_at desc), '[]'::jsonb) into rows from (
    select id, received_at, from_addr, from_name, subject, kind, filename, status, message, info from inbound_mail
    where account_id = p_account order by received_at desc limit 20) x;
  return rows;
end $$;

create or replace function inbound_mark(p_account uuid, p_id uuid, p_status text, p_message text default null) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  if p_status not in ('done', 'error', 'ignored', 'waiting') then raise exception 'Bad status' using errcode = '22023'; end if;
  update inbound_mail set status = p_status, message = left(p_message, 300), handled_at = now(),
    data = case when p_status in ('done', 'ignored') then null else data end
  where id = p_id and account_id = p_account;
end $$;

revoke all on function inbound_add(uuid, jsonb), inbound_waiting(uuid), inbound_recent(uuid), inbound_mark(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function inbound_waiting(uuid), inbound_recent(uuid), inbound_mark(uuid, uuid, text, text) to authenticated;
grant execute on function inbound_add(uuid, jsonb) to service_role;
