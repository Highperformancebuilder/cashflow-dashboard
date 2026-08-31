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

Connecting tries several of Google's CSV endpoints in turn and keeps the one
that works, so a `gid` in the pasted URL (whichever tab happened to be open
when the link was copied) never overrides the named tab. If every endpoint
fails, the error lists what each one reported.

> **Google returns the wrong tab rather than an error.** Measured against the
> live spreadsheet: `gviz/tq?...&sheet=<name>` answers with the **first tab**
> when `<name>` does not exist — HTTP 200, no warning — and
> `/export?format=csv&sheet=<name>` ignores the name outright, always returning
> the first tab. So a renamed secondary tab would otherwise show the working
> account's balances under another account's name. Every fetch is therefore
> checked against the tab it was meant to be: only the working account has a
> sales breakdown, so a grid with one is rejected for any other tab, and a grid
> without one is rejected for the working account. `/export?sheet=` is not used
> for secondary tabs at all, since it can only ever return the wrong one.

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

1. Run `testSnapshot()` once and approve the permission prompt. The log should
   report the week count, the four account balances, the row each figure came
   from, and `every figure matched a row by name`. Any `PARSE WARNINGS` line
   names exactly what it could not find.
2. Run `installTrigger()` once. This wires up the onChange trigger.
3. **Deploy → New deployment → Web app**, with *Execute as: Me* and
   *Who has access: Anyone*. Copy the `/exec` URL into `clients.script_url`.

> **Keep `clients.sheet_id` populated as well as `script_url`.** The realtime
> websocket subscribes on `sheet_id`; the dashboard can recover it from the
> snapshot the bridge returns, but setting both means realtime comes up on the
> first load rather than the second.

The bridge is worth installing even though polling works. Measured against the
live spreadsheet, one open dashboard polling every 5 seconds is ~720 function
invocations an hour and ~132 MB/hour through the proxy, because the working
tab exports 184 KB of CSV each time. The bridge pushes a **38 KB** snapshot
only when the sheet actually changes, and polls nothing.

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

Rows are found by **the label in their left-hand column**, not by row number.
These are the labels in the live sheet, with the row each currently sits on:

| Row | Label in the sheet | Feeds |
|---|---|---|
| 6 | `Week Commencing` | the week columns |
| 8 | `Opening Bank Balance` | Opening Balance |
| 65 | `Total Sales` | YTD Total Sales |
| 74 | `Total Other Income` | — |
| 76 | `Total Business Receipts (Cash Inwards)` | **Cash In** |
| 98 | `Total Supplier Payments` | weekly breakdown |
| 215 | `Total Business Payments (Cash Outwards)` | **Cash Out** |
| 217 | `Closing Bank Balance` | Closing Balance |

Week **columns** are discovered by scanning the week-date row, so appending
weeks needs no code change. Rows can be inserted, deleted or moved freely —
matching is by label.

Several wordings are accepted for each row (`Total Receipts`, `Total Business
Receipts`, `Total Cash In`, … all resolve to Cash In); see `ROW_LABELS` in
`index.html` and `apps-script/Code.gs`. If a row cannot be matched by name the
parser falls back to its position relative to the week-date row, and only if
*that* row holds figures — a blank row is reported as missing rather than read
as a column of zeros.

Anything still missing is reconstructed from the identity
`closing = opening + in − out`, so a sheet that names its receipts row
unusually still shows real cash movement. The Connect tab labels every figure
as **matched / guessed / calculated / not found**, and the dashboard raises a
banner whenever anything was not matched by name.

> **Why this matters.** The first version matched only `Total Receipts` and
> `Total Payments Out`. The live sheet says `Total Business Receipts (Cash
> Inwards)` and `Total Business Payments (Cash Outwards)`, so both rows fell
> through to the offset fallback — and because gviz silently drops blank rows,
> those offsets landed on a supplier row and past the end of the sheet. Cash
> In, Cash Out and Net read $0 on every one of 213 weeks while opening and
> closing balances looked perfectly normal.

### Tabs read

| Tab | Supplies | Required |
|---|---|---|
| `Business Working Account` | the whole weekly series | yes |
| `Regulation Bank Account` | opening + closing balance | no |
| `Business Savings Account` | opening + closing balance | no |
| `Profit Reinvest. Bank Account` | opening + closing balance | no |

All four are read on connect and refreshed every 60 seconds (the weekly series
refreshes every 5). A tab that cannot be read is reported as unread in the
Connect panel, and its card on the 4 Accounts tab shows a dash — never a
placeholder figure, which on a cashflow dashboard would be worse than a blank.

The three secondary tabs carry no `Week Commencing` label, so their date row is
located by finding the row that holds dates; opening and closing are matched by
their own labels as usual.

Two cases that are **not** failures, and are no longer reported as such:

- **A balance of $0** is a real balance. The Profit Reinvestment account is
  legitimately empty; it shows `$0`, not a dash.
- **A tab with no column for the current week** still shows its most recent
  figure, labelled with the date it is actually from ("Last figure in this tab
  is from 10 Jul 2025"). Passing a year-old balance off as this week's is worse
  than showing nothing.

Tab names are matched exactly by Google, so each is also tried under its known
aliases (`Profit Reinvest. Bank Account`, `Profit Reinvestment Bank Account`, …)
before the tab is given up on.

When the Apps Script bridge is installed it enumerates **every** tab in the
spreadsheet and lists the ones the dashboard does not read, so "are all my tabs
being picked up?" has a visible answer. A CSV endpoint cannot list tabs, so
that line is absent on the polling path.

---

## Tests

All test tooling lives in `tests/`, including its `package.json`. That is
deliberate: Netlify runs `npm install` whenever it finds a `package.json` in
the base directory, and **the site itself has no build step and no runtime
dependencies** — keeping it out of the root leaves the deploy untouched.

```bash
cd tests
```

Two suites run with no browser and nothing installed:

```bash
node url-test.js              # URL parsing
node rowdetect-test.js        # sheet-layout parsing, label matching
```

The rest drive a real browser. Install Playwright once:

```bash
npm install
npx playwright install chromium
```

Then, with the fixture server running in another terminal:

```bash
npm run serve                 # static server + mock sheet endpoint, port 8099

npm run test:e2e              # happy path, incl. a simulated realtime push
npm run test:e2e:nochart      # same, with the Chart.js CDN blocked
npm run test:degraded         # CDN failures, RLS denial, unlinked account
npm run test:connect          # Connect tab, validation, 5s update loop
npm run test:tabs             # all four account tabs, and missing-tab handling
```

Set `CHROME_PATH` to use a browser you already have instead of Playwright's
bundled Chromium:

```bash
CHROME_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" npm run test:e2e
```

---

## Known gaps

- **Client receipts are still hardcoded.** The `CLIENTS` array in
  `index.html` does not come from the spreadsheet, so the Clients tab does
  not update on edit. The data does exist in the sheet — the Working Account
  tab lists each client on its own row between `Sales:` and `Total Sales`
  (rows 12–45) — so this is now wireable, but it is not wired yet.
- **FY2024 / FY2025 totals are hardcoded** historical constants. They are
  not in the current spreadsheet.
- **The regulation account's super/PAYG/BAS weekly figures** are static
  descriptive text, not parsed values.
- **"Projected Revenue / Total Out / Net Position"** on the FY Performance
  tab sums actuals and projections together, so it labels historical
  months as "projected".
