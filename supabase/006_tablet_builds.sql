-- Custom builds from the tablet: "Not on the menu?" drink and dish specs, made with AI.
-- Run once: Supabase > SQL Editor > New query > paste all of this > Run. Safe to run again.
-- Needs 005_tablet_book.sql first.

do $$ begin
  if to_regclass('public.book_shares') is null then
    raise exception 'Run supabase/005_tablet_book.sql first (in the project your app uses), then this file.';
  end if;
end $$;

-- A daily cap per tablet link, so a link that gets out can't run up the AI bill.
alter table book_shares add column if not exists ai_day date;
alter table book_shares add column if not exists ai_count integer not null default 0;

create table if not exists tablet_builds (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid not null references accounts(id) on delete cascade,
  created_at  timestamptz not null default now(),
  prompt      text,
  data        jsonb not null
);
create index if not exists tablet_builds_account on tablet_builds (account_id, created_at desc);
alter table tablet_builds enable row level security;   -- no policies: functions only

-- ---------- for the tablet (no login): only with the link code ----------
-- Counts one AI build against today's cap. Returns false when the link is off or the cap is reached.
create or replace function book_ai_ok(p_token text, p_cap integer default 100) returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  if p_token is null or length(p_token) < 40 then return false; end if;
  update book_shares
     set ai_count = case when ai_day = current_date then ai_count + 1 else 1 end,
         ai_day = current_date
   where token = p_token and (ai_day is distinct from current_date or ai_count < least(greatest(coalesce(p_cap, 100), 1), 500))
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- What the kitchen stocks (names only, for building with what's on hand).
create or replace function book_stock(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(s.data->'stock', '[]'::jsonb) from book_shares s where s.token = p_token and length(p_token) >= 40;
$$;

-- "Save for the manager": keeps a custom build so it shows up in the Test kitchen.
create or replace function book_save_build(p_token text, p_prompt text, p_data jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
declare acct uuid;
begin
  select account_id into acct from book_shares where token = p_token and length(p_token) >= 40;
  if acct is null then return false; end if;
  if pg_column_size(p_data) > 60000 then raise exception 'Too large' using errcode = '54000'; end if;
  if (select count(*) from tablet_builds where account_id = acct and created_at > now() - interval '1 day') >= 50 then return false; end if;
  insert into tablet_builds (account_id, prompt, data) values (acct, left(p_prompt, 300), p_data);
  return true;
end $$;

-- ---------- for people in the app ----------
create or replace function tablet_builds_list(p_account uuid) returns table (id uuid, created_at timestamptz, prompt text, data jsonb)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  return query select b.id, b.created_at, b.prompt, b.data from tablet_builds b where b.account_id = p_account order by b.created_at desc limit 30;
end $$;

create or replace function tablet_build_delete(p_account uuid, p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  delete from tablet_builds where account_id = p_account and id = p_id;
end $$;

revoke all on function book_ai_ok(text, integer), book_stock(text), book_save_build(text, text, jsonb), tablet_builds_list(uuid), tablet_build_delete(uuid, uuid) from public, anon, authenticated;
grant execute on function book_ai_ok(text, integer), book_stock(text), book_save_build(text, text, jsonb) to anon, authenticated;
grant execute on function tablet_builds_list(uuid), tablet_build_delete(uuid, uuid) to authenticated;
