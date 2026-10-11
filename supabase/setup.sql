-- foodcosting101: logins and per-kitchen data.
-- Paste this whole file into Supabase > SQL Editor > New query, then click Run.
-- Safe to run more than once.
--
-- How it's protected: the browser never touches these tables directly. Every read
-- and write goes through a function below that first checks the signed-in person
-- belongs to that kitchen. Row-level security is on with no table policies, so a
-- direct table query from a browser returns nothing.

create extension if not exists pgcrypto;

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 120),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists account_members (
  account_id uuid not null references accounts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  email text,
  role text not null default 'member' check (role in ('owner', 'manager', 'member')),
  joined_at timestamptz not null default now(),
  primary key (account_id, user_id)
);

create table if not exists invites (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references accounts(id) on delete cascade,
  email text not null,
  role text not null default 'member' check (role in ('manager', 'member')),
  invited_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  accepted_at timestamptz
);
create unique index if not exists invites_one_open_per_email on invites (account_id, lower(email)) where accepted_at is null;

-- The app's data for each kitchen (menu, supplies, invoices, settings), saved as one document.
create table if not exists app_state (
  account_id uuid primary key references accounts(id) on delete cascade,
  state jsonb not null,
  version integer not null default 1,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

alter table accounts enable row level security;
alter table account_members enable row level security;
alter table invites enable row level security;
alter table app_state enable row level security;
revoke all on accounts, account_members, invites, app_state from anon, authenticated;

-- ---------- helpers ----------
create or replace function _my_email() returns text language sql stable as $$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$$;

create or replace function _role_in(p_account uuid) returns text
language sql stable security definer set search_path = public as $$
  select role from account_members where account_id = p_account and user_id = auth.uid();
$$;

create or replace function _require_member(p_account uuid, p_roles text[] default array['owner','manager','member']) returns text
language plpgsql stable security definer set search_path = public as $$
declare r text;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  r := _role_in(p_account);
  if r is null or not (r = any(p_roles)) then raise exception 'Not allowed' using errcode = '42501'; end if;
  return r;
end $$;

-- ---------- functions the app calls ----------

-- Kitchens I belong to.
create or replace function my_accounts() returns table (id uuid, name text, role text)
language sql stable security definer set search_path = public as $$
  select a.id, a.name, m.role from accounts a join account_members m on m.account_id = a.id
  where m.user_id = auth.uid() order by a.created_at;
$$;

-- Join any kitchens I've been invited to (matched by the email I signed in with).
create or replace function accept_invites() returns integer
language plpgsql security definer set search_path = public as $$
declare n integer := 0; i record;
begin
  if auth.uid() is null or _my_email() = '' then return 0; end if;
  -- Only trust the email once Supabase has confirmed the person owns it.
  if not exists (select 1 from auth.users u where u.id = auth.uid() and u.email_confirmed_at is not null) then return 0; end if;
  for i in select * from invites where lower(email) = _my_email() and accepted_at is null loop
    insert into account_members (account_id, user_id, email, role) values (i.account_id, auth.uid(), _my_email(), i.role)
    on conflict (account_id, user_id) do nothing;
    update invites set accepted_at = now() where id = i.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Start a new kitchen. The person who creates it is the owner.
create or replace function create_account(p_name text, p_state jsonb) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'Not signed in' using errcode = '28000'; end if;
  if (select count(*) from account_members where user_id = auth.uid() and role = 'owner') >= 10 then
    raise exception 'Limit of 10 kitchens per person' using errcode = '54000';
  end if;
  if pg_column_size(p_state) > 4000000 then raise exception 'Data too large' using errcode = '54000'; end if;
  insert into accounts (name, created_by) values (trim(p_name), auth.uid()) returning id into v_id;
  insert into account_members (account_id, user_id, email, role) values (v_id, auth.uid(), _my_email(), 'owner');
  insert into app_state (account_id, state, updated_by) values (v_id, coalesce(p_state, '{}'::jsonb), auth.uid());
  return v_id;
end $$;

create or replace function load_state(p_account uuid) returns table (state jsonb, version integer, role text)
language plpgsql stable security definer set search_path = public as $$
declare r text;
begin
  r := _require_member(p_account);
  return query select s.state, s.version, r from app_state s where s.account_id = p_account;
end $$;

-- Save, but only if nobody else saved since I loaded (base version must match).
create or replace function save_state(p_account uuid, p_state jsonb, p_base_version integer) returns integer
language plpgsql security definer set search_path = public as $$
declare v integer;
begin
  perform _require_member(p_account);
  if pg_column_size(p_state) > 4000000 then raise exception 'Data too large' using errcode = '54000'; end if;
  update app_state set state = p_state, version = version + 1, updated_at = now(), updated_by = auth.uid()
  where account_id = p_account and version = p_base_version
  returning version into v;
  if v is null then raise exception 'Someone else saved first' using errcode = '40001'; end if;
  return v;
end $$;

-- Cheap check for "has anyone else saved?"
create or replace function state_version(p_account uuid) returns integer
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  return (select version from app_state where account_id = p_account);
end $$;

-- Team list: members plus invites that haven't been accepted yet.
create or replace function team(p_account uuid) returns table (kind text, user_id uuid, invite_id uuid, email text, role text, since timestamptz, is_me boolean)
language plpgsql stable security definer set search_path = public as $$
begin
  perform _require_member(p_account);
  return query
    select 'member'::text, m.user_id, null::uuid, m.email, m.role, m.joined_at, m.user_id = auth.uid() from account_members m where m.account_id = p_account
    union all
    select 'invite'::text, null::uuid, i.id, i.email, i.role, i.created_at, false from invites i where i.account_id = p_account and i.accepted_at is null
    order by 6;
end $$;

create or replace function invite_member(p_account uuid, p_email text, p_role text default 'member') returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; e text := lower(trim(p_email));
begin
  perform _require_member(p_account, array['owner','manager']);
  if e !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'That email address doesn''t look right' using errcode = '22023'; end if;
  if p_role not in ('manager', 'member') then raise exception 'Role must be manager or member' using errcode = '22023'; end if;
  if exists (select 1 from account_members where account_id = p_account and lower(email) = e) then raise exception 'They''re already on the team' using errcode = '23505'; end if;
  insert into invites (account_id, email, role, invited_by) values (p_account, e, p_role, auth.uid())
  on conflict (account_id, lower(email)) where accepted_at is null do update set role = excluded.role
  returning id into v_id;
  return v_id;
end $$;

create or replace function cancel_invite(p_invite uuid) returns void
language plpgsql security definer set search_path = public as $$
declare a uuid;
begin
  select account_id into a from invites where id = p_invite and accepted_at is null;
  if a is null then return; end if;
  perform _require_member(a, array['owner','manager']);
  delete from invites where id = p_invite;
end $$;

create or replace function remove_member(p_account uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
declare my_role text; their_role text;
begin
  my_role := _require_member(p_account);
  select role into their_role from account_members where account_id = p_account and user_id = p_user;
  if their_role is null then return; end if;
  if p_user <> auth.uid() and my_role <> 'owner' then raise exception 'Only an owner can remove people' using errcode = '42501'; end if;
  if their_role = 'owner' and (select count(*) from account_members where account_id = p_account and role = 'owner') = 1 then
    raise exception 'A kitchen needs at least one owner' using errcode = '42501';
  end if;
  delete from account_members where account_id = p_account and user_id = p_user;
end $$;

create or replace function set_member_role(p_account uuid, p_user uuid, p_role text) returns void
language plpgsql security definer set search_path = public as $$
begin
  perform _require_member(p_account, array['owner']);
  if p_role not in ('owner', 'manager', 'member') then raise exception 'Unknown role' using errcode = '22023'; end if;
  if p_user = auth.uid() and p_role <> 'owner' and (select count(*) from account_members where account_id = p_account and role = 'owner') = 1 then
    raise exception 'A kitchen needs at least one owner' using errcode = '42501';
  end if;
  update account_members set role = p_role where account_id = p_account and user_id = p_user;
end $$;

-- Only signed-in people can call the app functions; helpers stay private.
revoke all on function _my_email(), _role_in(uuid), _require_member(uuid, text[]) from public, anon, authenticated;
revoke all on function my_accounts(), accept_invites(), create_account(text, jsonb), load_state(uuid), save_state(uuid, jsonb, integer),
  state_version(uuid), team(uuid), invite_member(uuid, text, text), cancel_invite(uuid), remove_member(uuid, uuid), set_member_role(uuid, uuid, text) from public, anon;
grant execute on function my_accounts(), accept_invites(), create_account(text, jsonb), load_state(uuid), save_state(uuid, jsonb, integer),
  state_version(uuid), team(uuid), invite_member(uuid, text, text), cancel_invite(uuid), remove_member(uuid, uuid), set_member_role(uuid, uuid, text) to authenticated;
