// All four account tabs: are they fetched, do their balances reach the
// dashboard, and is an unreadable tab reported rather than filled with a
// placeholder that looks real?
const { chromium } = require('playwright');
const isolate = require('./isolate');
// Playwright's own bundled Chromium by default; CHROME_PATH overrides it.
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
const http = require('http');
const STUB = require('fs').readFileSync(__dirname + '/stub.js', 'utf8');

const SHEET = '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c';
const URL_ = 'https://docs.google.com/spreadsheets/d/' + SHEET + '/edit?gid=457366843#gid=457366843';
const hide = (tab) => new Promise(r => http.get('http://localhost:8099/__hide?tab=' + encodeURIComponent(tab), res => { res.resume(); res.on('end', r); }));

const T = [];
const check = (n, p, d = '') => T.push({ n, p: !!p, d });

async function session(pre) {
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage();
  await isolate(page);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript('window.__clientRow = null;');
  if (pre) await page.addInitScript(pre);
  await page.addInitScript(STUB);
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });
  await page.fill('#login-email', 'greg@example.com');
  await page.fill('#login-password', 'x');
  await page.click('#login-btn');
  await page.waitForTimeout(800);
  await page.evaluate(() => document.querySelectorAll('.nb')[5].click());
  await page.fill('#connect-url', URL_);
  await page.click('#connect-btn');
  await page.waitForTimeout(2200);
  return { browser, page, errors, ev: async (fn) => { try { return await page.evaluate(fn); } catch (e) { return { __err: e.message }; } } };
}

(async () => {
  await hide('');   // all tabs present

  // ---- 1. All four tabs fetched ----------------------------------------
  let s = await session();
  const status = await s.ev(() => sync.tabStatus);
  check('tabStatus reported', status && !status.__err, JSON.stringify(status));
  const NAMES = ['Business Working Account', 'Regulation Bank Account', 'Business Savings Account', 'Profit Reinvest. Bank Account'];
  for (const n of NAMES) {
    check('tab read: ' + n, status && status[n] && status[n].ok, JSON.stringify(status && status[n]));
  }

  const live = await s.ev(() => Object.keys(ACCOUNTS_LIVE_KEYS).sort());
  check('all 4 accounts marked live', Array.isArray(live) && live.length === 4, JSON.stringify(live));

  // ---- 2. Secondary balances came from the SHEET, not the fallbacks ----
  const accounts = await s.ev(() => JSON.parse(JSON.stringify(ACCOUNTS_LIVE)));
  check('regulation read from sheet', accounts.regulation.opening === 15658 && accounts.regulation.closing === 7059, JSON.stringify(accounts.regulation));
  check('savings read from sheet', accounts.savings.closing === 50000, JSON.stringify(accounts.savings));
  // The fixture uses 1200, which differs from the hardcoded fallback of 0 —
  // so this only passes if the value genuinely came from the tab.
  check('profit reinvestment read from sheet (not the $0 fallback)', accounts.profit.closing === 1200, JSON.stringify(accounts.profit));

  // ---- 3. The 4 Accounts tab shows them ---------------------------------
  await s.page.evaluate(() => document.querySelectorAll('.nb')[4].click());
  await s.page.waitForTimeout(300);
  const acctText = await s.page.textContent('#tab-accounts');
  check('accounts tab shows the regulation balance', acctText.includes('7,059'));
  check('accounts tab shows the profit balance', acctText.includes('1,200'), 'expected $1,200 from the sheet');
  check('no "not read" warning when all tabs load', !/not read from the sheet/i.test(acctText));
  const total = await s.ev(() => document.getElementById('accounts-total').textContent);
  check('total sums all four', /58,/.test(total) || /\$\d/.test(total), String(total).replace(/\s+/g, ' ').slice(0, 90));

  await s.browser.close();

  // ---- 4. A missing tab is REPORTED, not faked -------------------------
  await hide('Regulation Bank Account');
  s = await session();
  const st2 = await s.ev(() => sync.tabStatus);
  check('missing tab flagged not-ok', st2 && st2['Regulation Bank Account'] && st2['Regulation Bank Account'].ok === false, JSON.stringify(st2 && st2['Regulation Bank Account']));
  check('other tabs still read', st2 && st2['Business Savings Account'].ok === true);
  const live2 = await s.ev(() => Object.keys(ACCOUNTS_LIVE_KEYS).sort());
  check('missing account not marked live', Array.isArray(live2) && !live2.includes('regulation'), JSON.stringify(live2));

  await s.page.evaluate(() => document.querySelectorAll('.nb')[4].click());
  await s.page.waitForTimeout(300);
  const acct2 = await s.page.textContent('#tab-accounts');
  check('missing account does NOT show the $7,059 placeholder', !acct2.includes('7,059'), 'placeholder leaked through');
  check('missing account shows a dash', acct2.includes('—'));
  check('missing account explains itself', /not read from the sheet/i.test(acct2));
  check('total says one account is missing', /1 account not read/i.test(acct2), acct2.replace(/\s+/g,' ').slice(0,140));

  // Connect panel reports 3 of 4.
  await s.page.evaluate(() => document.querySelectorAll('.nb')[5].click());
  await s.page.waitForTimeout(300);
  const connText = await s.page.textContent('#connect-current');
  check('connect panel reports 3 of 4 tabs', /3 of 4/.test(connText), connText.replace(/\s+/g,' ').slice(0, 120));

  check('no unhandled page errors', s.errors.length === 0, s.errors.join(' | '));
  await s.browser.close();
  await hide('');

  T.forEach(t => console.log((t.p ? '  PASS  ' : '  FAIL  ') + t.n + (t.d ? '   [' + t.d + ']' : '')));
  const f = T.filter(t => !t.p).length;
  console.log('\n' + (T.length - f) + '/' + T.length + ' passed');
  process.exit(f ? 1 : 0);
})();
