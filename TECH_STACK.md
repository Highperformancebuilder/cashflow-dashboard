# Tech stack and requirements

Greg Jones — Cashflow Dashboard.

## The short version

**This project has zero runtime dependencies.** There is no build step, no
bundler, no framework, and nothing to install in order to deploy it. The whole
front end is a single `index.html` served as a static file, plus one serverless
function that imports nothing.

The only package this repository installs anywhere is Playwright, and that is
used exclusively for running the browser tests. It never ships.

That is a deliberate design choice, not an omission: a dashboard whose only job
is to display someone's bank balances should not be able to break because a
transitive npm dependency changed.

---

## 1. Runtime stack (the deployed site)

| Layer | Technology | Version | How it is loaded |
|---|---|---|---|
| Markup / styling | HTML5 + hand-written CSS | — | inline in `index.html` |
| Application code | Vanilla JavaScript (ES2017+) | — | two inline `<script>` blocks |
| Charts | Chart.js | 4.4.0 | CDN (`cdn.jsdelivr.net`) |
| Auth + realtime client | `@supabase/supabase-js` | 2.x | CDN (`cdn.jsdelivr.net`) |
| Typeface | Manrope | — | Google Fonts |

**No package manager is involved in serving the site.** The two libraries are
`<script src>` tags. Both are optional at runtime — if either CDN is
unreachable the dashboard degrades rather than failing:

- Chart.js missing → charts are replaced with "Chart unavailable — offline";
  every figure still renders.
- Supabase SDK missing → the sign-in button is disabled with an explanation
  instead of the page dying on an undefined global.

Browser support: any evergreen browser. The code uses `async`/`await`,
`fetch`, template-free string concatenation, `const`/`let`, and arrow
functions. No transpilation, no polyfills.

---

## 2. Serverless function

| Item | Value |
|---|---|
| File | `netlify/functions/sheet.js` |
| Runtime | Node.js (Netlify default, 18+) |
| Dependencies | **none** — uses the global `fetch` (Node 18+) |
| Bundler | esbuild, configured in `netlify.toml` |

The function is a CORS proxy with a host allowlist. It contains its own
RFC 4180 CSV parser rather than pulling in a CSV library.

---

## 3. Managed services

| Service | Used for | Notes |
|---|---|---|
| **Netlify** | Static hosting + the serverless function | `publish = "."`, build command is a no-op echo |
| **Supabase** | Postgres, Auth, Realtime websockets | Row-level security is mandatory — see below |
| **Google Sheets** | The source of truth for all figures | Read over the public CSV/gviz endpoints |
| **Google Apps Script** | Optional realtime bridge | `apps-script/Code.gs`, runs inside the spreadsheet |
| **GitHub** | Source control, triggers Netlify deploys | |

### Supabase requirements

Run `supabase/schema.sql` before going live. It creates two tables
(`clients`, `sheet_snapshots`), enables row-level security on both, and adds
`sheet_snapshots` to the realtime publication.

> The Supabase **publishable** key is committed in `index.html` by design —
> that is what the key is for. RLS is the only thing that makes it safe. Verify
> it is on:
>
> ```sql
> select tablename, rowsecurity from pg_tables
>  where schemaname = 'public' and tablename in ('clients','sheet_snapshots');
> ```
>
> Both must return `true`.

The **service_role** key is only needed by the Apps Script bridge and lives
exclusively in Apps Script → Project Settings → Script Properties. It must
never appear in `index.html`, in this repository, or in any client-side code.

---

## 4. Development and test tooling

Declared in `tests/package.json`. Nothing here is required to build, deploy or
run the site.

| Tool | Version | Purpose |
|---|---|---|
| Node.js | 22.x LTS (tested on 22.23.0) | runs the test scripts |
| npm | 10.x (tested on 10.9.8) | installs Playwright |
| Playwright | ^1.47 (tested on 1.62.1) | drives a real browser for the e2e suites |
| Chromium | bundled with Playwright (build 1234) | the browser under test |

Two of the seven suites (`url-test.js`, `rowdetect-test.js`) need **Node
only** — no browser, no npm install.

---

## 5. What you actually need, by task

### To view the deployed site
A browser. Nothing else.

### To deploy
Push to the connected branch. Netlify serves the repository as-is. There is
nothing to compile.

### To run the site locally
```bash
cd tests
node server.js          # static server + a mock Google Sheets endpoint, port 8099
```
Open `http://localhost:8099/`. Note the Netlify function is not available
locally; `tests/server.js` stands in for it.

### To run the tests
```bash
cd tests
node url-test.js                 # no install needed
node rowdetect-test.js           # no install needed

npm install                      # installs Playwright
npx playwright install chromium  # downloads the browser
npm run serve                    # in one terminal
npm run test:e2e                 # in another
```

### To install the realtime bridge
A Google account with edit access to the spreadsheet, plus the Supabase
service_role key. See the Setup section of `README.md`.

---

## 6. Why there is no `requirements.txt` or root `package.json`

**`requirements.txt` is a Python convention and there is no Python in this
project.** Adding one would be inaccurate, and at the repository root it is
actively harmful: Netlify auto-detects `requirements.txt` and will start
running `pip install` on every deploy of a site that has no Python in it.

The same applies to `package.json`. Netlify runs `npm install` whenever it
finds one in the base directory, so the test tooling deliberately lives in
`tests/package.json` where the deploy will never see it. `node_modules/` and
`package-lock.json` are gitignored.

If a checklist demands a file with a specific name, put it in a `docs/`
subdirectory so the build system does not act on it. This file is the
authoritative dependency manifest.

---

## 7. Version summary

```
# Runtime — loaded from CDN, not installed
chart.js                4.4.0
@supabase/supabase-js    2.x

# Serverless
node                   >=18        (Netlify managed; global fetch required)

# Development only — tests/package.json
node                    22.x LTS
npm                     10.x
playwright             ^1.47.0

# Managed services
Netlify        static hosting + functions
Supabase       Postgres 15+, Auth, Realtime
Google Sheets  CSV / gviz export endpoints
Apps Script    V8 runtime (optional bridge)
```
