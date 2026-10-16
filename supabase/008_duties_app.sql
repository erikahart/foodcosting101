-- Lets people in the app check off duties too (the tablet already can). Run once after 007_duties.sql. Safe to run again.
do $$ begin
  if to_regclass('public.duty_checks') is null then
    raise exception 'Run supabase/007_duties.sql first (in the project your app uses), then this file.';
  end if;
end $$;

create or replace function duty_set(p_account uuid, p_day date, p_list text, p_item text, p_by text, p_done boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  if p_day < current_date - 1 or p_day > current_date + 1 then return false; end if;
  if length(coalesce(p_list,'')) = 0 or length(p_list) > 40 or length(coalesce(p_item,'')) = 0 or length(p_item) > 40 then return false; end if;
  if p_done then
    insert into duty_checks (account_id, day, list_id, item_id, done_by, done_at) values (p_account, p_day, p_list, p_item, left(nullif(trim(p_by), ''), 40), now())
    on conflict (account_id, day, list_id, item_id) do update set done_by = excluded.done_by, done_at = now();
  else
    delete from duty_checks where account_id = p_account and day = p_day and list_id = p_list and item_id = p_item;
  end if;
  return true;
end $$;

revoke all on function duty_set(uuid, date, text, text, text, boolean) from public, anon, authenticated;
grant execute on function duty_set(uuid, date, text, text, text, boolean) to authenticated;
