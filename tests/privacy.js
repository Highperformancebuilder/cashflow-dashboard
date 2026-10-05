// Two people, one browser.
//   1. Nobody sees the previous user's spreadsheet or figures after sign-out.
//   2. Before a user connects a spreadsheet, every tab is blank — no figures,
//      and no built-in "sample" data (which used to be Greg's real numbers).
const { chromium } = require('playwright');
const isolate = require('./isolate');
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
const STUB = require('fs').readFileSync(__dirname + '/stub.js', 'utf8');
const SHEET = '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET + '/edit';

const T = [];
const check = (n, c, d = '') => T.push({ n, ok: !!c, d });

async function signIn(page, email, clientRow) {
  await page.evaluate(([row]) => {
    window.__clientRow = row;
    // stub.js only accepts one address; who signs in is what is under test.
    sb.auth.signInWithPassword = async () => ({ data: {}, error: null });
  }, [clientRow]);
  await page.fill('#login-email', email);
  await page.fill('#login-password', 'x');
  await page.click('#login-btn');
  await page.waitForTimeout(1300);
}

async function signOut(page) {
  await page.evaluate(() => { handleLogout(); });   // reloads the page
  await page.waitForTimeout(800);
  await page.waitForLoadState('networkidle');
}

/** Everything a user could see of somebody's figures, tab by tab. */
const visible = (page) => page.evaluate(() => ({
  weeks: WEEKLY.length,
  months: MONTHLY.length,
  clientsLive: !!CLIENTS_LIVE,
  source: sync.source,
  sheetId: sync.sheetId,
  ovClose: document.getElementById('ov-close').textContent.trim(),
  ovIn: document.getElementById('ov-in').textContent.trim(),
  ytd: document.getElementById('ytd-sales').textContent.trim(),
  weekCards: document.querySelectorAll('#weekly-list .gcard').length,
  fyYears: document.querySelectorAll('#monthly-list .fysec').length,
  clientCards: document.querySelectorAll('#client-list .gcard').length,
  accountCards: document.querySelectorAll('#accounts-grid .acard').length,
  obligationsShown: !document.getElementById('accounts-obligations').hidden,
  riskBadge: getComputedStyle(document.getElementById('risk-badge')).display,
  banner: document.getElementById('sync-banner').textContent.trim()
}));

const isBlank = (v) =>
  v.weeks === 0 && v.months === 0 && !v.clientsLive &&
  v.ovClose === '—' && v.ovIn === '—' && v.ytd === '—' &&
  v.weekCards === 0 && v.fyYears === 0 && v.clientCards === 0 && v.accountCards === 0 &&
  !v.obligationsShown && v.riskBadge === 'none';

(async () => {
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await isolate(page);
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.addInitScript(STUB);
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });

  // ---- 0. the page itself carries nobody's figures ------------------------
  const src = await page.evaluate(() => fetch('/index.html').then(r => r.text()));
  const leaked = ['Christian College', 'Avery Constructions', 'David McDonald', '253102', '1490154', '-28889.79']
    .filter(x => src.includes(x));
  check('page source contains no client names or figures', leaked.length === 0, JSON.stringify(leaked));

  // ---- 1. a user with no sheet: every tab blank ----------------------------
  await signIn(page, 'first@x.com', null);
  let v = await visible(page);
  check('signed in, no sheet: every tab is blank', isBlank(v), JSON.stringify(v));
  check('  ...and the banner points at Connect', /Connect/.test(v.banner), v.banner);
  for (const [i, tab] of [[1, 'weekly-list'], [2, 'monthly-list'], [3, 'client-list'], [4, 'accounts-grid']]) {
    await page.evaluate(n => document.querySelectorAll('.nb')[n].click(), i);
    await page.waitForTimeout(150);
    check('  ...' + tab + ' offers to connect a spreadsheet',
      /Connect a spreadsheet/.test(await page.textContent('#' + tab)));
  }

  // ---- 2. that user connects a sheet, then signs out ----------------------
  await page.evaluate(() => document.getElementById('nb-connect').click());
  await page.fill('#connect-url', SHEET_URL);
  await page.click('#connect-btn');
  await page.waitForTimeout(2200);
  v = await visible(page);
  check('after connecting, their figures load', v.weeks > 0 && /\$/.test(v.ovClose), JSON.stringify({ w: v.weeks, c: v.ovClose }));
  check('  ...the connection is remembered for THEM',
    await page.evaluate(() => JSON.parse(localStorage.getItem('gj_cashflow_source')).owner === 'first@x.com'));

  await signOut(page);
  check('sign-out returns to the login screen', await page.isVisible('#login-screen'));
  check('sign-out wipes every figure from memory',
    await page.evaluate(() => WEEKLY.length === 0 && MONTHLY.length === 0 && !CLIENTS_LIVE && sync.source === null));

  // ---- 3. a SECOND person signs in on the same browser --------------------
  await signIn(page, 'second@x.com', null);
  v = await visible(page);
  check('second person does NOT get the first person\'s sheet', v.source === null && v.sheetId === null, JSON.stringify(v.source));
  check('second person sees a blank dashboard, not the first person\'s figures', isBlank(v), JSON.stringify(v));
  await signOut(page);

  // ---- 4. the first person comes back: their own sheet is restored --------
  await signIn(page, 'first@x.com', null);
  v = await visible(page);
  check('the first person gets their own remembered sheet back', v.sheetId === SHEET && v.weeks > 0, String(v.sheetId));
  await signOut(page);

  // ---- 5. a user WITH a sheet, then someone without, same tab ------------
  await signIn(page, 'greg@example.com', { sheet_id: SHEET, is_admin: false });
  v = await visible(page);
  check('a user with a linked sheet sees their figures', v.weeks > 0, 'weeks=' + v.weeks);
  await signOut(page);
  await signIn(page, 'third@x.com', null);
  v = await visible(page);
  check('the next user sees none of them', isBlank(v), JSON.stringify(v));
  await signOut(page);

  // ---- 6. disconnecting blanks the dashboard too ---------------------------
  await signIn(page, 'first@x.com', null);
  await page.evaluate(() => disconnectSheet());
  await page.waitForTimeout(300);
  v = await visible(page);
  check('disconnect returns every tab to blank', isBlank(v), JSON.stringify(v));

  check('no page errors', errs.length === 0, errs.join(' | '));
  await browser.close();

  const fails = T.filter(t => !t.ok);
  T.forEach(t => console.log((t.ok ? '  PASS  ' : '  FAIL  ') + t.n + (t.d && !t.ok ? '   [' + t.d + ']' : '')));
  console.log('\n' + (T.length - fails.length) + '/' + T.length + ' passed');
  process.exit(fails.length ? 1 : 0);
})();
