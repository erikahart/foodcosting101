-- "Can't do it" with a reason, and the morning email about missed duties.
-- Run once after 007_duties.sql and 008_duties_app.sql: Supabase > SQL Editor > New query > paste > Run. Safe to run again.
do $$ begin
  if to_regclass('public.duty_checks') is null then
    raise exception 'Run supabase/007_duties.sql and 008_duties_app.sql first (in the project your app uses), then this file.';
  end if;
end $$;

alter table duty_checks add column if not exists status text not null default 'done';   -- 'done' or 'skipped'
alter table duty_checks add column if not exists note text;                              -- the reason, when skipped

create table if not exists duty_alerts_sent (
  account_id uuid not null references accounts(id) on delete cascade,
  day        date not null,
  sent_at    timestamptz not null default now(),
  sent_to    text,
  missed     integer not null default 0,
  primary key (account_id, day)
);
alter table duty_alerts_sent enable row level security;

-- Reads now include the status and reason (return types changed, so these are replaced).
drop function if exists book_duty_checks(text, date);
create function book_duty_checks(p_token text, p_day date) returns table (list_id text, item_id text, done_by text, done_at timestamptz, status text, note text)
language sql stable security definer set search_path = public as $$
  select c.list_id, c.item_id, c.done_by, c.done_at, c.status, c.note
  from book_shares s join duty_checks c on c.account_id = s.account_id
  where s.token = p_token and length(p_token) >= 40 and c.day = p_day;
$$;
drop function if exists duty_checks_list(uuid, date, date);
create function duty_checks_list(p_account uuid, p_from date, p_to date) returns table (day date, list_id text, item_id text, done_by text, done_at timestamptz, status text, note text)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  return query select c.day, c.list_id, c.item_id, c.done_by, c.done_at, c.status, c.note from duty_checks c
    where c.account_id = p_account and c.day between p_from and least(p_to, p_from + 62) order by c.day, c.done_at;
end $$;

-- Mark a duty done or "can't do it" (with a reason), or clear it. p_status null clears.
create or replace function _duty_write(acct uuid, p_day date, p_list text, p_item text, p_by text, p_status text, p_note text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if p_day < current_date - 1 or p_day > current_date + 1 then return false; end if;
  if length(coalesce(p_list,'')) = 0 or length(p_list) > 40 or length(coalesce(p_item,'')) = 0 or length(p_item) > 40 then return false; end if;
  if p_status is null then
    delete from duty_checks where account_id = acct and day = p_day and list_id = p_list and item_id = p_item; return true;
  end if;
  if p_status not in ('done', 'skipped') then return false; end if;
  if (select count(*) from duty_checks where account_id = acct and day = p_day) >= 500 then return false; end if;
  insert into duty_checks (account_id, day, list_id, item_id, done_by, done_at, status, note)
    values (acct, p_day, p_list, p_item, left(nullif(trim(p_by), ''), 40), now(), p_status, case when p_status = 'skipped' then left(nullif(trim(p_note), ''), 200) end)
  on conflict (account_id, day, list_id, item_id) do update set done_by = excluded.done_by, done_at = now(), status = excluded.status, note = excluded.note;
  return true;
end $$;
create or replace function book_duty_mark(p_token text, p_day date, p_list text, p_item text, p_by text, p_status text, p_note text) returns boolean
language plpgsql security definer set search_path = public as $$
declare acct uuid;
begin
  select account_id into acct from book_shares where token = p_token and length(p_token) >= 40;
  if acct is null then return false; end if;
  return _duty_write(acct, p_day, p_list, p_item, p_by, p_status, p_note);
end $$;
create or replace function duty_mark(p_account uuid, p_day date, p_list text, p_item text, p_by text, p_status text, p_note text) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  return _duty_write(p_account, p_day, p_list, p_item, p_by, p_status, p_note);
end $$;

-- ---------- server only (secret key): the morning alert ----------
-- Kitchens with missed-duty alerts switched on, with their current location's schedule and duty lists, and that day's checks.
create or replace function duty_alert_accounts(p_day date) returns table (account_id uuid, name text, place jsonb, checks jsonb, already boolean)
language sql stable security definer set search_path = public as $$
  select a.id, a.name, st.state #> array['restaurants', st.state->>'current'],
         coalesce((select jsonb_agg(jsonb_build_object('list_id', c.list_id, 'item_id', c.item_id, 'done_by', c.done_by, 'status', c.status, 'note', c.note))
                   from duty_checks c where c.account_id = a.id and c.day = p_day), '[]'::jsonb),
         exists (select 1 from duty_alerts_sent s where s.account_id = a.id and s.day = p_day)
  from accounts a join app_state st on st.account_id = a.id
  where coalesce((st.state #> array['restaurants', st.state->>'current', 'dutyAlerts', 'on'])::text, 'false') = 'true';
$$;
create or replace function duty_alert_sent(p_account uuid, p_day date, p_to text, p_missed integer) returns void
language sql security definer set search_path = public as $$
  insert into duty_alerts_sent (account_id, day, sent_to, missed) values (p_account, p_day, left(p_to, 300), p_missed)
  on conflict (account_id, day) do update set sent_at = now(), sent_to = excluded.sent_to, missed = excluded.missed;
$$;

revoke all on function book_duty_checks(text, date), duty_checks_list(uuid, date, date), _duty_write(uuid, date, text, text, text, text, text),
  book_duty_mark(text, date, text, text, text, text, text), duty_mark(uuid, date, text, text, text, text, text),
  duty_alert_accounts(date), duty_alert_sent(uuid, date, text, integer) from public, anon, authenticated;
grant execute on function book_duty_checks(text, date), book_duty_mark(text, date, text, text, text, text, text) to anon, authenticated;
grant execute on function duty_checks_list(uuid, date, date), duty_mark(uuid, date, text, text, text, text, text) to authenticated;
grant execute on function duty_alert_accounts(date), duty_alert_sent(uuid, date, text, integer) to service_role;
