-- Events calendar: lets the tablet show events from your connected calendars (bookings) without ever seeing their secret addresses.
-- Run once after 005_tablet_book.sql: Supabase > SQL Editor > New query > paste > Run. Safe to run again.
do $$ begin
  if to_regclass('public.book_shares') is null then raise exception 'Run supabase/005_tablet_book.sql first, then this file.'; end if;
end $$;
-- Server only (secret key): the calendar feeds for a tablet link's kitchen.
create or replace function cal_feeds_for_token(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(st.state #> array['restaurants', st.state->>'current', 'calFeeds'], '[]'::jsonb)
  from book_shares s join app_state st on st.account_id = s.account_id
  where s.token = p_token and length(p_token) >= 40;
$$;
revoke all on function cal_feeds_for_token(text) from public, anon, authenticated;
grant execute on function cal_feeds_for_token(text) to service_role;
