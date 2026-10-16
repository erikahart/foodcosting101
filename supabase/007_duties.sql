-- Cleaning and prep duties: checkoffs made on the tablet, seen by managers in the app.
-- Run once: Supabase > SQL Editor > New query > paste all of this > Run. Safe to run again.
-- Needs 005_tablet_book.sql first. (The schedule and the duty lists themselves live with the rest of the kitchen data.)

do $$ begin
  if to_regclass('public.book_shares') is null then
    raise exception 'Run supabase/005_tablet_book.sql first (in the project your app uses), then this file.';
  end if;
end $$;

create table if not exists duty_checks (
  account_id  uuid not null references accounts(id) on delete cascade,
  day         date not null,
  list_id     text not null,
  item_id     text not null,
  done_by     text,
  done_at     timestamptz not null default now(),
  primary key (account_id, day, list_id, item_id)
);
alter table duty_checks enable row level security;   -- no policies: functions only

-- ---------- for the tablet (no login): only with the link code ----------
create or replace function book_duty_checks(p_token text, p_day date) returns table (list_id text, item_id text, done_by text, done_at timestamptz)
language sql stable security definer set search_path = public as $$
  select c.list_id, c.item_id, c.done_by, c.done_at
  from book_shares s join duty_checks c on c.account_id = s.account_id
  where s.token = p_token and length(p_token) >= 40 and c.day = p_day;
$$;

-- Check or uncheck one duty for a day (only today or yesterday, for late closes). Capped so a stray link can't flood it.
create or replace function book_duty_set(p_token text, p_day date, p_list text, p_item text, p_by text, p_done boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare acct uuid;
begin
  select account_id into acct from book_shares where token = p_token and length(p_token) >= 40;
  if acct is null then return false; end if;
  if p_day < current_date - 1 or p_day > current_date + 1 then return false; end if;
  if length(coalesce(p_list,'')) = 0 or length(p_list) > 40 or length(coalesce(p_item,'')) = 0 or length(p_item) > 40 then return false; end if;
  if p_done then
    if (select count(*) from duty_checks where account_id = acct and day = p_day) >= 500 then return false; end if;
    insert into duty_checks (account_id, day, list_id, item_id, done_by, done_at) values (acct, p_day, p_list, p_item, left(nullif(trim(p_by), ''), 40), now())
    on conflict (account_id, day, list_id, item_id) do update set done_by = excluded.done_by, done_at = now();
  else
    delete from duty_checks where account_id = acct and day = p_day and list_id = p_list and item_id = p_item;
  end if;
  return true;
end $$;

-- ---------- for people in the app ----------
create or replace function duty_checks_list(p_account uuid, p_from date, p_to date) returns table (day date, list_id text, item_id text, done_by text, done_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  return query select c.day, c.list_id, c.item_id, c.done_by, c.done_at from duty_checks c
    where c.account_id = p_account and c.day between p_from and least(p_to, p_from + 62) order by c.day, c.done_at;
end $$;

revoke all on function book_duty_checks(text, date), book_duty_set(text, date, text, text, text, boolean), duty_checks_list(uuid, date, date) from public, anon, authenticated;
grant execute on function book_duty_checks(text, date), book_duty_set(text, date, text, text, text, boolean) to anon, authenticated;
grant execute on function duty_checks_list(uuid, date, date) to authenticated;
