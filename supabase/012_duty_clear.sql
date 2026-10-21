-- Clear duties that weren't done (closed, closed early, not needed), so they stop counting as missed.
-- Run once after 009_duty_alerts.sql: Supabase > SQL Editor > New query > paste > Run. Safe to run again.
do $$ begin
  if to_regprocedure('public._duty_write(uuid,date,text,text,text,text,text)') is null then
    raise exception 'Run supabase/009_duty_alerts.sql first (in the project your app uses), then this file.';
  end if;
end $$;

-- Owners, managers and members given "Can edit the schedule" can clear duties, for today or the past 90 days.
-- p_clear = true removes the clearing again. Duties already marked done are left alone.
create or replace function duty_excuse(p_account uuid, p_day date, p_list text, p_items text[], p_by text, p_note text, p_clear boolean default false) returns integer
language plpgsql security definer set search_path = public as $$
declare role text; ok boolean; n integer := 0; it text;
begin
  select m.role into role from account_members m where m.account_id = p_account and m.user_id = auth.uid();
  if role is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  if role not in ('owner', 'manager') then
    select coalesce((st.state #>> array['perms', auth.uid()::text, 'schedule'])::boolean, false) into ok from app_state st where st.account_id = p_account;
    if not coalesce(ok, false) then raise exception 'Only managers can clear duties' using errcode = '42501'; end if;
  end if;
  if p_day < current_date - 90 or p_day > current_date + 1 then return 0; end if;
  if length(coalesce(p_list, '')) = 0 or length(p_list) > 40 then return 0; end if;
  foreach it in array coalesce(p_items, array[]::text[]) loop
    continue when length(coalesce(it, '')) = 0 or length(it) > 40;
    if p_clear then
      delete from duty_checks where account_id = p_account and day = p_day and list_id = p_list and item_id = it and status = 'excused';
    else
      insert into duty_checks (account_id, day, list_id, item_id, done_by, done_at, status, note)
        values (p_account, p_day, p_list, it, left(nullif(trim(p_by), ''), 40), now(), 'excused', left(nullif(trim(p_note), ''), 200))
      on conflict (account_id, day, list_id, item_id) do update set status = 'excused', note = excluded.note, done_by = excluded.done_by, done_at = now()
        where duty_checks.status <> 'done';
    end if;
    get diagnostics n = row_count; 
  end loop;
  return coalesce(array_length(p_items, 1), 0);
end $$;

revoke all on function duty_excuse(uuid, date, text, text[], text, text, boolean) from public, anon, authenticated;
grant execute on function duty_excuse(uuid, date, text, text[], text, text, boolean) to authenticated;
