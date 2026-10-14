-- Recipe photos for the Kitchen book.
-- Run once in Supabase: SQL Editor -> New query -> paste all of this -> Run.
-- Safe to run more than once.
--
-- Photos live in their own table so the main kitchen data stays small and fast.
-- Like everything else, the table is locked: the app reaches it only through the
-- functions below, which check that you belong to the kitchen.

-- Stop with a clear message if this isn't the app's project (the one that already has your kitchens).
do $$ begin
  if to_regclass('public.accounts') is null or to_regprocedure('public._require_member(uuid, text[])') is null then
    raise exception 'This Supabase project is not the one your app uses: it has no "accounts" table. Open the project whose ID matches config.js (Project Settings > General > Project ID) and run this script there. If the app has never been set up in this project, run setup.sql first.';
  end if;
end $$;

create table if not exists item_photos (
  account_id uuid not null references accounts(id) on delete cascade,
  item_id    text not null,
  data       text not null,              -- a small JPEG as a data URL
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (account_id, item_id)
);
alter table item_photos enable row level security;   -- no policies: direct access is denied

-- Photos for a kitchen. Pass item ids to fetch just those, or null for all.
create or replace function get_photos(p_account uuid, p_items text[] default null)
returns table (item_id text, data text, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  return query select p.item_id, p.data, p.updated_at from item_photos p
    where p.account_id = p_account and (p_items is null or p.item_id = any(p_items));
end $$;

-- Add or replace one photo. Anyone in the kitchen can, so cooks can photograph plates.
create or replace function save_photo(p_account uuid, p_item text, p_data text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  if p_item is null or length(p_item) > 80 then raise exception 'Bad item' using errcode = '22023'; end if;
  if p_data is null or p_data not like 'data:image/%' then raise exception 'Not an image' using errcode = '22023'; end if;
  if length(p_data) > 700000 then raise exception 'Photo too large' using errcode = '54000'; end if;
  insert into item_photos (account_id, item_id, data, updated_at, updated_by)
    values (p_account, p_item, p_data, now(), auth.uid())
  on conflict (account_id, item_id) do update set data = excluded.data, updated_at = now(), updated_by = auth.uid();
end $$;

create or replace function delete_photo(p_account uuid, p_item text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  delete from item_photos where account_id = p_account and item_id = p_item;
end $$;

revoke all on function get_photos(uuid, text[]), save_photo(uuid, text, text), delete_photo(uuid, text) from public, anon;
grant execute on function get_photos(uuid, text[]), save_photo(uuid, text, text), delete_photo(uuid, text) to authenticated;
