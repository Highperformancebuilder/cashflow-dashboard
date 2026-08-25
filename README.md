# Greg Jones — Cashflow Dashboard

A live cashflow forecast dashboard for High Performance Builder. Static
front-end, Supabase for authentication, Google Sheets as the source of truth.

Editing the spreadsheet updates every open dashboard within a few seconds.

---

## How live sync works

Google Sheets cannot push changes to a browser — there is no realtime
subscription for Sheets. "Realtime" is therefore assembled from parts:

```
 you edit the spreadsheet
        |
        v
 Apps Script onChange trigger          (fires ~1-3s after the edit)
        |  parses the four account sheets into one compact snapshot
        v
 Supabase table  sheet_snapshots       (one row per spreadsheet, overwritten)
        |  Postgres change event
        v
 Supabase Realtime websocket
        |
        v
 dashboard applySnapshot() -> re-render
```

If the websocket is unavailable, or the Apps Script trigger has not been
installed, the dashboard falls back to polling the sheet every 5 seconds
through the Netlify function. The header badge always says which mode is
active:

| Badge | Meaning |
|---|---|
| `● Live` | Realtime websocket connected. Edits appear in seconds. |
| `◐ Polling` | Websocket unavailable. Refreshing every 5s. |
| `○ Not connected` | No sheet connected. Showing sample data. |
| `⚠ Sync failed` | Something broke. The banner explains what. |

Apps Script is the **only** place that parses spreadsheet rows and columns.
The dashboard consumes a versioned JSON contract and never touches row
numbers, so a sheet layout change is a one-file fix.

---

## Connecting a sheet

The **Connect** tab takes a spreadsheet link, validates it, and starts syncing.
It accepts any of:

| Paste this | Update speed |
|---|---|
| `https://docs.google.com/spreadsheets/d/<id>/edit` | ~5s polling |
| the bare spreadsheet id | ~5s polling |
| a published-to-web CSV link (`/pub?output=csv`) | ~5s polling, but Google's CDN can lag several minutes |
| an Apps Script `/exec` link (the bridge below) | instant, via websocket |

The sheet must be shared **Anyone with the link → Viewer**, and the weekly
figures must live on a tab named `Business Working Account` in the layout
below. A bad link is rejected without disturbing a working connection.

The connection is remembered in `localStorage` and, if the `clients` UPDATE
policy is applied, written back to the signed-in account so it follows the
user to another browser. **Disconnect** clears both.

For an ordinary sheet link the dashboard reads the `gviz` endpoint rather
than the published CSV, because published CSV is CDN-cached and would defeat
5-second polling.

> **Netlify usage note.** Polling every 5 seconds is roughly 720 function
> invocations per hour per open dashboard. Polling pauses automatically while
> the browser tab is hidden, but a dashboard left open all day on the free
> tier will approach the monthly invocation limit. The Apps Script bridge
> avoids this entirely — it pushes over a websocket and does not poll.

## Repository layout

| Path | Purpose |
|---|---|
| `index.html` | The whole dashboard: markup, styles, rendering, sync. |
| `apps-script/Code.gs` | Paste into the spreadsheet's Apps Script project. The canonical parser. |
| `netlify/functions/sheet.js` | CORS proxy for Google. Host-allowlisted. |
| `netlify.toml` | Netlify build and function config. |
| `supabase/schema.sql` | Tables, RLS policies, Realtime publication. |
| `tests/` | Browser tests (see below). |

---

## Setup

### 1. Supabase

Run `supabase/schema.sql` in the Supabase SQL editor. It creates `clients`
and `sheet_snapshots`, **enables Row Level Security on both**, and adds
`sheet_snapshots` to the Realtime publication.

Then link the login to the spreadsheet — uncomment and edit the `insert` at
the bottom of the file, or do it through the table editor:

| Column | Value |
|---|---|
| `email` | the Supabase Auth user's email |
| `sheet_id` | the `/d/<id>/` segment of the spreadsheet URL |
| `script_url` | the Apps Script `/exec` URL from step 2 |

Verify RLS is actually on before going live:

```sql
select tablename, rowsecurity from pg_tables
 where schemaname = 'public' and tablename in ('clients','sheet_snapshots');
```

Both rows must show `rowsecurity = t`. Until they do, the publishable key in
`index.html` lets anyone read every client email and sheet id.

### 2. Apps Script

In the spreadsheet: **Extensions → Apps Script**. Replace the default file
with `apps-script/Code.gs`.

Set **Project Settings → Script Properties**:

| Property | Value |
|---|---|
| `SHEET_ID` | the spreadsheet id |
| `SUPABASE_URL` | `https://<project>.supabase.co` |
| `SUPABASE_SERVICE_KEY` | the **service_role** key |

> The service_role key bypasses RLS. It lives only in Script Properties,
> server-side. Never put it in `index.html`.

Then:

1. Run `testSnapshot()` once and check the log — it should report the week
   count and the four account balances. Approve the permission prompt.
2. Run `installTrigger()` once. This wires up the onChange trigger.
3. **Deploy → New deployment → Web app**, with *Execute as: Me* and
   *Who has access: Anyone*. Copy the `/exec` URL into `clients.script_url`.

### 3. Netlify

Connect the repo. `netlify.toml` already sets the publish directory and
functions path, so no build configuration is needed in the UI.

---

## Verifying it works

1. Sign in. The badge should reach `● Live` within a few seconds.
2. Change a receipts figure in the Working Account sheet.
3. Within roughly 5 seconds the dashboard figures update without a refresh.

If the badge stays on `◐ Polling`, the Realtime subscription is not
connecting — check that `sheet_snapshots` is in the `supabase_realtime`
publication and that the signed-in user's `clients.sheet_id` matches the
`sheet_id` Apps Script is writing.

---

## Spreadsheet layout contract

`apps-script/Code.gs` reads these **1-based row numbers**. Moving a row
breaks parsing; add rows below rather than reordering.

| Row | Meaning |
|---|---|
| 6 | Week start dates |
| 8 | Opening balance |
| 65 | Total sales |
| 74 | Total other income |
| 76 | Total receipts |
| 98 | Total supplier payments |
| 215 | Total payments out |
| 217 | Closing bank balance |

Week **columns** are discovered by scanning row 6 for dates, so appending
weeks needs no code change.

Sheets read: `Business Working Account`, `Regulation Bank Account`,
`Business Savings Account`, `Profit Reinvest. Bank Account`.

---

## Tests

Browser tests covering the sync layer, the failure paths and the realtime
update. They need Playwright and Chromium available.

```bash
node tests/server.js &        # static server + mock sheet endpoint
node tests/e2e.js             # happy path, incl. a simulated realtime push
node tests/e2e.js --no-chart  # same, with the Chart.js CDN blocked
node tests/degraded.js        # CDN failures, RLS denial, unlinked account
node tests/connect.js         # Connect tab, validation, 5s update loop
node tests/url-test.js        # URL parsing (no browser needed)
```

---

## Known gaps

- **Client receipts are still hardcoded.** The `CLIENTS` array in
  `index.html` does not come from the spreadsheet, so the Clients tab does
  not update on edit. It needs a source sheet before it can be wired in.
- **FY2024 / FY2025 totals are hardcoded** historical constants. They are
  not in the current spreadsheet.
- **The regulation account's super/PAYG/BAS weekly figures** are static
  descriptive text, not parsed values.
- **"Projected Revenue / Total Out / Net Position"** on the FY Performance
  tab sums actuals and projections together, so it labels historical
  months as "projected".
