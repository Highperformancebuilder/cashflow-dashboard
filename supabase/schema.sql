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

-- Deny-by-default is implicit once RLS is on; these grant the narrow reads.

drop policy if exists "clients: read own row" on public.clients;
create policy "clients: read own row"
  on public.clients
  for select
  to authenticated
  using ( lower(email) = lower(auth.jwt() ->> 'email') );

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
-- 6. Verify RLS is actually on (should return rowsecurity = true for both).
-- ---------------------------------------------------------------------------

-- select tablename, rowsecurity
--   from pg_tables
--  where schemaname = 'public'
--    and tablename in ('clients', 'sheet_snapshots');
