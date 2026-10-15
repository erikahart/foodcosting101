-- Automatic supplier feeds (GFS EDI over SFTP).
-- Run once: Supabase > SQL Editor > New query > paste all of this > Run. Safe to run again.
--
-- The scheduled server job uses the project's secret key (kept only in Netlify) to call the
-- feed_* functions marked "server only" below. People in the app can only switch the feed on or
-- off (owners and managers) and see what was collected.

do $$ begin
  if to_regclass('public.accounts') is null or to_regclass('public.app_state') is null then
    raise exception 'Run this in the Supabase project your app uses (the one with your kitchens). It has no "accounts" table.';
  end if;
end $$;

create table if not exists feed_config (
  account_id uuid not null references accounts(id) on delete cascade,
  source     text not null,                 -- e.g. 'gfs'
  enabled    boolean not null default true,
  restaurant text,                          -- which location's inbox; null = the kitchen's current one
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid(),
  primary key (account_id, source)
);
create table if not exists feed_files (
  account_id  uuid not null references accounts(id) on delete cascade,
  source      text not null,
  filename    text not null,
  received_at timestamptz not null default now(),
  docs        integer not null default 0,
  status      text not null,                -- 'added', 'duplicate', 'skipped', 'error'
  message     text,
  primary key (account_id, source, filename)
);
alter table feed_config enable row level security;   -- no policies: functions only
alter table feed_files  enable row level security;

-- ---------- for people in the app ----------
create or replace function feed_enable(p_account uuid, p_source text, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account, array['owner','manager']);
  insert into feed_config (account_id, source, enabled, updated_at, updated_by) values (p_account, lower(p_source), p_on, now(), auth.uid())
  on conflict (account_id, source) do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
end $$;

create or replace function feed_status(p_account uuid, p_source text) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare cfg feed_config; files jsonb;
begin
  perform _require_member(p_account);
  select * into cfg from feed_config where account_id = p_account and source = lower(p_source);
  select coalesce(jsonb_agg(to_jsonb(f) - 'account_id' order by f.received_at desc), '[]'::jsonb) into files
    from (select * from feed_files where account_id = p_account and source = lower(p_source) order by received_at desc limit 15) f;
  return jsonb_build_object('enabled', coalesce(cfg.enabled, false), 'files', files);
end $$;

-- ---------- server only (secret key) ----------
create or replace function feed_targets(p_source text) returns table (account_id uuid, restaurant text)
language sql stable security definer set search_path = public as $$
  select c.account_id, c.restaurant from feed_config c where c.source = lower(p_source) and c.enabled;
$$;

create or replace function feed_seen(p_account uuid, p_source text, p_names text[]) returns setof text
language sql stable security definer set search_path = public as $$
  select filename from feed_files where account_id = p_account and source = lower(p_source) and filename = any(p_names);
$$;

-- Adds documents to a kitchen's inbox (skipping invoices already there) and records the file.
create or replace function feed_add(p_account uuid, p_source text, p_filename text, p_docs jsonb, p_status text default 'added', p_message text default null, p_restaurant text default null)
returns integer language plpgsql security definer set search_path = public as $$
declare st jsonb; rid text; inbox jsonb; d jsonb; added integer := 0;
begin
  select state into st from app_state where account_id = p_account for update;
  if st is null then raise exception 'Kitchen not found' using errcode = 'P0002'; end if;
  rid := coalesce(nullif(p_restaurant, ''), st->>'current');
  if rid is null or (st #> array['restaurants', rid]) is null then
    select k into rid from jsonb_object_keys(st->'restaurants') k limit 1;
  end if;
  inbox := coalesce(st #> array['restaurants', rid, 'inbox'], '[]'::jsonb);
  for d in select * from jsonb_array_elements(coalesce(p_docs, '[]'::jsonb)) loop
    if exists (select 1 from jsonb_array_elements(inbox) e
               where e->>'kind' = d->>'kind' and lower(coalesce(e->>'supplier','')) = lower(coalesce(d->>'supplier',''))
                 and coalesce(e->>'number','') = coalesce(d->>'number','') and d->>'kind' = 'invoice') then
      continue;
    end if;
    inbox := inbox || jsonb_build_array(d); added := added + 1;
  end loop;
  if added > 0 then
    update app_state set state = jsonb_set(state, array['restaurants', rid, 'inbox'], inbox), version = version + 1, updated_at = now(), updated_by = null
      where account_id = p_account;
  end if;
  insert into feed_files (account_id, source, filename, docs, status, message)
    values (p_account, lower(p_source), p_filename, added, case when p_status = 'added' and added = 0 and jsonb_array_length(coalesce(p_docs,'[]')) > 0 then 'duplicate' else p_status end, p_message)
  on conflict (account_id, source, filename) do update set docs = excluded.docs, status = excluded.status, message = excluded.message, received_at = now();
  return added;
end $$;

revoke all on function feed_enable(uuid, text, boolean), feed_status(uuid, text), feed_targets(text), feed_seen(uuid, text, text[]), feed_add(uuid, text, text, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function feed_enable(uuid, text, boolean), feed_status(uuid, text) to authenticated;
grant execute on function feed_targets(text), feed_seen(uuid, text, text[]), feed_add(uuid, text, text, jsonb, text, text, text) to service_role;
