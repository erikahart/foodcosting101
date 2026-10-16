-- Schedule change requests from the tablet (no account needed): time off, swaps, can't make a shift.
-- Run once after 005_tablet_book.sql: Supabase > SQL Editor > New query > paste > Run. Safe to run again.
do $$ begin
  if to_regclass('public.book_shares') is null then
    raise exception 'Run supabase/005_tablet_book.sql first (in the project your app uses), then this file.';
  end if;
end $$;

create table if not exists schedule_requests (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  person      text not null,          -- name as it shows on the schedule
  person_id   text,                   -- schedule person id
  kind        text not null check (kind in ('off', 'swap', 'cant', 'other')),
  day         date,
  day_to      date,
  shift_text  text,
  cover       text,
  message     text,
  status      text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  reply       text,
  decided_at  timestamptz,
  decided_by  text
);
create index if not exists schedule_requests_account on schedule_requests (account_id, created_at desc);
alter table schedule_requests enable row level security;   -- no policies: functions only

-- ---------- server only (the tablet's request goes through a Netlify function that also emails managers) ----------
create or replace function schedule_request_add(p_token text, p_person text, p_person_id text, p_kind text, p_day date, p_day_to date, p_shift text, p_cover text, p_message text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare acct uuid; kname text; place jsonb; rid uuid;
begin
  select s.account_id into acct from book_shares s where s.token = p_token and length(p_token) >= 40;
  if acct is null then return jsonb_build_object('ok', false, 'reason', 'link'); end if;
  if coalesce(trim(p_person), '') = '' or p_kind not in ('off', 'swap', 'cant', 'other') then return jsonb_build_object('ok', false, 'reason', 'bad'); end if;
  if p_day is not null and (p_day < current_date - 1 or p_day > current_date + 400) then return jsonb_build_object('ok', false, 'reason', 'bad'); end if;
  if (select count(*) from schedule_requests where account_id = acct and created_at > now() - interval '1 day') >= 40 then return jsonb_build_object('ok', false, 'reason', 'cap'); end if;
  insert into schedule_requests (account_id, person, person_id, kind, day, day_to, shift_text, cover, message)
    values (acct, left(trim(p_person), 40), left(p_person_id, 40), p_kind, p_day, case when p_day_to >= p_day then p_day_to end, left(p_shift, 80), left(nullif(trim(p_cover), ''), 40), left(nullif(trim(p_message), ''), 500))
    returning id into rid;
  select a.name, st.state #> array['restaurants', st.state->>'current'] into kname, place from accounts a join app_state st on st.account_id = a.id where a.id = acct;
  return jsonb_build_object('ok', true, 'id', rid, 'kitchen', coalesce(place->>'name', kname),
    'emails', coalesce(place #> '{schedAlerts,emails}', place #> '{dutyAlerts,emails}', '[]'::jsonb),
    'on', coalesce((place #>> '{schedAlerts,on}')::boolean, true));
end $$;

-- ---------- for the tablet (no login): one person's recent requests, with the manager's answer ----------
create or replace function book_requests(p_token text, p_person_id text) returns table (id uuid, created_at timestamptz, kind text, day date, day_to date, shift_text text, status text, reply text)
language sql stable security definer set search_path = public as $$
  select r.id, r.created_at, r.kind, r.day, r.day_to, r.shift_text, r.status, r.reply
  from book_shares s join schedule_requests r on r.account_id = s.account_id
  where s.token = p_token and length(p_token) >= 40 and r.person_id = p_person_id and r.created_at > now() - interval '60 days'
  order by r.created_at desc limit 10;
$$;

-- ---------- for people in the app ----------
create or replace function schedule_requests_list(p_account uuid) returns setof schedule_requests
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  return query select * from schedule_requests r where r.account_id = p_account and (r.status = 'pending' or r.created_at > now() - interval '30 days') order by (r.status = 'pending') desc, r.created_at desc limit 100;
end $$;

-- Approve or deny: owners, managers, and members given "Can edit the schedule".
create or replace function schedule_request_decide(p_account uuid, p_id uuid, p_status text, p_reply text) returns boolean
language plpgsql security definer set search_path = public as $$
declare role text; ok boolean;
begin
  select m.role into role from account_members m where m.account_id = p_account and m.user_id = auth.uid();
  if role is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  if role not in ('owner', 'manager') then
    select coalesce((st.state #>> array['perms', auth.uid()::text, 'schedule'])::boolean, false) into ok from app_state st where st.account_id = p_account;
    if not coalesce(ok, false) then raise exception 'Only managers can answer schedule requests' using errcode = '42501'; end if;
  end if;
  if p_status not in ('approved', 'denied', 'pending') then return false; end if;
  update schedule_requests set status = p_status, reply = left(nullif(trim(p_reply), ''), 300), decided_at = case when p_status = 'pending' then null else now() end,
    decided_by = (select email from auth.users where id = auth.uid())
  where id = p_id and account_id = p_account;
  return found;
end $$;

revoke all on function schedule_request_add(text, text, text, text, date, date, text, text, text), book_requests(text, text), schedule_requests_list(uuid), schedule_request_decide(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function schedule_request_add(text, text, text, text, date, date, text, text, text) to service_role;
grant execute on function book_requests(text, text) to anon, authenticated;
grant execute on function schedule_requests_list(uuid), schedule_request_decide(uuid, uuid, text, text) to authenticated;
