-- Tablet Kitchen book: a private link that shows recipe cards (no costs or prices) without logging in.
-- Run once: Supabase > SQL Editor > New query > paste all of this > Run. Safe to run again.
--
-- How it's protected: the app publishes a copy of the recipe cards only (names, photos, ingredients and
-- amounts, steps, allergens), never prices, costs or suppliers. The copy can only be read with its long
-- random link code. Owners and managers can turn the link off or replace it at any time.

do $$ begin
  if to_regclass('public.accounts') is null or to_regclass('public.item_photos') is null then
    raise exception 'Run this in the Supabase project your app uses, after 002_recipe_photos.sql (it needs the accounts and item_photos tables).';
  end if;
end $$;

create table if not exists book_shares (
  account_id  uuid primary key references accounts(id) on delete cascade,
  token       text not null unique,
  restaurant  text,
  data        jsonb not null default '{}'::jsonb,   -- recipe cards only; built by the app
  updated_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
alter table book_shares enable row level security;   -- no policies: functions only

create or replace function _new_book_token() returns text language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
$$;

-- ---------- for people in the app ----------
-- Turn the link on (owners and managers). Returns the link code.
create or replace function book_share_enable(p_account uuid, p_restaurant text, p_data jsonb) returns text
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  perform _require_member(p_account, array['owner','manager']);
  if pg_column_size(p_data) > 2000000 then raise exception 'Too much data for the tablet book' using errcode = '54000'; end if;
  insert into book_shares (account_id, token, restaurant, data, updated_at, created_by)
    values (p_account, _new_book_token(), p_restaurant, coalesce(p_data, '{}'::jsonb), now(), auth.uid())
  on conflict (account_id) do update set restaurant = excluded.restaurant, data = excluded.data, updated_at = now()
  returning token into t;
  return t;
end $$;

-- Keep the tablet copy current (anyone in the kitchen, since cooks edit cards too). Does nothing if the link is off.
create or replace function book_share_update(p_account uuid, p_restaurant text, p_data jsonb) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  if pg_column_size(p_data) > 2000000 then raise exception 'Too much data for the tablet book' using errcode = '54000'; end if;
  update book_shares set data = coalesce(p_data, data), restaurant = coalesce(p_restaurant, restaurant), updated_at = now() where account_id = p_account;
  return found;
end $$;

create or replace function book_share_status(p_account uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s book_shares;
begin
  perform _require_member(p_account);
  select * into s from book_shares where account_id = p_account;
  if s.account_id is null then return jsonb_build_object('on', false); end if;
  return jsonb_build_object('on', true, 'token', s.token, 'restaurant', s.restaurant, 'updated_at', s.updated_at);
end $$;

-- Replace the link (the old one stops working) or turn it off.
create or replace function book_share_new_link(p_account uuid) returns text
language plpgsql security definer set search_path = public as $$
declare t text;
begin
  perform _require_member(p_account, array['owner','manager']);
  update book_shares set token = _new_book_token(), updated_at = now() where account_id = p_account returning token into t;
  return t;
end $$;

create or replace function book_share_off(p_account uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account, array['owner','manager']);
  delete from book_shares where account_id = p_account;
end $$;

-- ---------- for the tablet (no login): only with the link code ----------
create or replace function book_public(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('book', s.data, 'updated_at', s.updated_at)
  from book_shares s where s.token = p_token and length(p_token) >= 40;
$$;

-- Photos for cards in that kitchen's book (only items listed in the shared copy).
create or replace function book_public_photos(p_token text, p_items text[]) returns table (item_id text, data text)
language sql stable security definer set search_path = public as $$
  select p.item_id, p.data
  from book_shares s
  join item_photos p on p.account_id = s.account_id
  where s.token = p_token and length(p_token) >= 40
    and p.item_id = any(p_items)
    and exists (select 1 from jsonb_array_elements(s.data->'items') it where it->>'id' = p.item_id)
  limit 60;
$$;

revoke all on function _new_book_token() from public, anon, authenticated;
revoke all on function book_share_enable(uuid, text, jsonb), book_share_update(uuid, text, jsonb), book_share_status(uuid), book_share_new_link(uuid), book_share_off(uuid),
  book_public(text), book_public_photos(text, text[]) from public, anon, authenticated;
grant execute on function book_share_enable(uuid, text, jsonb), book_share_update(uuid, text, jsonb), book_share_status(uuid), book_share_new_link(uuid), book_share_off(uuid) to authenticated;
grant execute on function book_public(text), book_public_photos(text, text[]) to anon, authenticated;
