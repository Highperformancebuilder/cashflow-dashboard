-- Greg Jones Cashflow — Supabase schema, RLS and Realtime setup.
-- Run this in the Supabase SQL editor. It is idempotent; re-running is safe.

-- ---------------------------------------------------------------------------
-- 1. clients — maps a login to the spreadsheet they are allowed to see.
-- ---------------------------------------------------------------------------

create table if not exists public.clients (
  id          uuid primary key default gen_random_uuid(),
  email       text not null unique,
  full_name   text,
  sheet_id    text,   -- Google Spreadsheet id (the /d/<id>/ path segment)
  script_url  text,   -- Apps Script web-app /exec URL for this client's sheet
  created_at  timestamptz not null default now()
);

-- Older deployments created this table without script_url.
alter table public.clients add column if not exists script_url text;

-- Added for the Users tab (bulk import). is_admin marks the people allowed to
-- add and remove dashboard users; it can only be set from the SQL editor or by
-- the service-role key, never by a signed-in user (see the column grants below).
alter table public.clients add column if not exists first_name   text;
alter table public.clients add column if not exists last_name    text;
alter table public.clients add column if not exists company_name text;
alter table public.clients add column if not exists is_admin     boolean not null default false;
-- The Supabase login this row belongs to. Set by the importer; rows created by
-- hand before it existed are matched by email as before.
alter table public.clients add column if not exists user_id uuid references auth.users (id) on delete set null;

create index if not exists clients_email_idx on public.clients (lower(email));

-- ---------------------------------------------------------------------------
-- 2. sheet_snapshots — one row per spreadsheet, overwritten by Apps Script on
--    every edit. This is the table Realtime broadcasts from.
-- ---------------------------------------------------------------------------

create table if not exists public.sheet_snapshots (
  sheet_id    text primary key,
  payload     jsonb not null,
  updated_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 3. Row Level Security.
--
--    Without this, the publishable key shipped in index.html lets any visitor
--    read every row of clients (all customer emails and sheet ids) and every
--    snapshot. RLS is what makes that key safe to publish.
--
--    Policy: a signed-in user may read their own client row, and the snapshot
--    for the sheet that row points at. Nobody may read anything anonymously.
--    Writes are performed by Apps Script using the service_role key, which
--    bypasses RLS by design.
-- ---------------------------------------------------------------------------

alter table public.clients         enable row level security;
alter table public.sheet_snapshots enable row level security;

-- Table privileges. Newer Supabase projects no longer grant these by default,
-- so without them a signed-in user is refused before RLS is even consulted
-- ("permission denied for table clients") and sign-in cannot find their sheet.
-- RLS below still decides WHICH rows each user sees.
grant usage  on schema public                to anon, authenticated, service_role;
grant select on public.clients               to authenticated;
grant select on public.sheet_snapshots       to authenticated;
-- The import tool and the Apps Script bridge use the secret key.
grant select, insert, update, delete on public.clients         to service_role;
grant select, insert, update, delete on public.sheet_snapshots to service_role;
-- Visitors who are not signed in get nothing at all.
revoke all on public.clients, public.sheet_snapshots from anon;

-- Deny-by-default is implicit once RLS is on; these grant the narrow reads.

drop policy if exists "clients: read own row" on public.clients;
create policy "clients: read own row"
  on public.clients
  for select
  to authenticated
  using ( lower(email) = lower(auth.jwt() ->> 'email') );

-- The Connect tab writes the chosen sheet back to the user's own row so the
-- connection follows them to another browser. Scoped to their own row only,
-- and with check prevents re-pointing the row at somebody else's email.
-- Admins may read every client row, so the Users tab can list who has access.
-- The check runs as a security-definer function so the policy does not query
-- the table it protects (which would recurse).
create or replace function public.is_dashboard_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.clients
    where lower(email) = lower(auth.jwt() ->> 'email') and is_admin
  );
$$;
revoke all on function public.is_dashboard_admin() from public;
grant execute on function public.is_dashboard_admin() to authenticated;

-- Only admins (Greg) have the Connect tab, so only admins may do this. A
-- regular user re-pointing their own row at another sheet_id would gain read
-- access to that sheet's snapshot through the policy further down.
drop policy if exists "clients: update own row" on public.clients;
create policy "clients: update own row"
  on public.clients
  for update
  to authenticated
  using      ( lower(email) = lower(auth.jwt() ->> 'email') and public.is_dashboard_admin() )
  with check ( lower(email) = lower(auth.jwt() ->> 'email') );

-- The policy above limits WHICH row a user may update, not WHICH columns. On
-- its own it would let any signed-in user run
--   update clients set is_admin = true where email = <their own>
-- and promote themselves. Column privileges close that: a signed-in user may
-- change only the two columns the Connect tab writes.
revoke update on public.clients from authenticated;
grant  update (sheet_id, script_url) on public.clients to authenticated;
revoke insert, delete on public.clients from authenticated, anon;

drop policy if exists "clients: admins read all" on public.clients;
create policy "clients: admins read all"
  on public.clients
  for select
  to authenticated
  using ( public.is_dashboard_admin() );

drop policy if exists "snapshots: read own sheet" on public.sheet_snapshots;
create policy "snapshots: read own sheet"
  on public.sheet_snapshots
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.clients c
      where lower(c.email) = lower(auth.jwt() ->> 'email')
        and c.sheet_id = sheet_snapshots.sheet_id
    )
  );

-- ---------------------------------------------------------------------------
-- 4. Realtime — publish sheet_snapshots so postgres_changes fires on write.
--    RLS above still applies to Realtime, so a subscriber only receives
--    changes for a sheet they are entitled to read.
-- ---------------------------------------------------------------------------

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sheet_snapshots'
  ) then
    alter publication supabase_realtime add table public.sheet_snapshots;
  end if;
end
$$;

-- Realtime needs the full row image to deliver the payload on update.
alter table public.sheet_snapshots replica identity full;

-- ---------------------------------------------------------------------------
-- 5. Link the first client. Replace both values, then run.
-- ---------------------------------------------------------------------------

-- insert into public.clients (email, full_name, sheet_id, script_url)
-- values (
--   'greg@example.com',
--   'Greg Jones',
--   '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c',
--   'https://script.google.com/macros/s/<deployment-id>/exec'
-- )
-- on conflict (email) do update
--   set sheet_id   = excluded.sheet_id,
--       script_url = excluded.script_url,
--       full_name  = excluded.full_name;

-- ---------------------------------------------------------------------------
-- 5b. Make Greg the super-admin. Create his login first (Authentication →
--     Users → Add user, tick "Auto Confirm User"), then run this. Only admins
--     see the Import Users tab; everyone else is added and removed from there.
-- ---------------------------------------------------------------------------

-- insert into public.clients (email, first_name, last_name, full_name, is_admin, sheet_id, user_id)
-- select 'greg@gregjonesofficial.com', 'Greg', 'Jones', 'Greg Jones', true,
--        '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c', id
--   from auth.users where email = 'greg@gregjonesofficial.com'
-- on conflict (email) do update set is_admin = true, user_id = excluded.user_id;

-- ---------------------------------------------------------------------------
-- 6. Verify RLS is actually on (should return rowsecurity = true for both).
-- ---------------------------------------------------------------------------

-- select tablename, rowsecurity
--   from pg_tables
--  where schemaname = 'public'
--    and tablename in ('clients', 'sheet_snapshots');
