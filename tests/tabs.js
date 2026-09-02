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

  // ---- 5. the 4 Accounts tab follows the Overview week navigator ---------
  const s3 = await session();
  const accountsText = async () => {
    await s3.page.evaluate(() => document.querySelectorAll('.nb')[4].click());
    await s3.page.waitForTimeout(250);
    return (await s3.page.textContent('#tab-accounts')).replace(/\s+/g, ' ');
  };
  const overviewNums = async () => {
    await s3.page.evaluate(() => document.querySelectorAll('.nb')[0].click());
    await s3.page.waitForTimeout(250);
    return s3.page.evaluate(() => ({
      week: document.getElementById('cwl').textContent.trim(),
      open: document.getElementById('ov-open').textContent.trim(),
      close: document.getElementById('ov-close').textContent.trim(),
      in: document.getElementById('ov-in').textContent.trim(),
      out: document.getElementById('ov-out').textContent.trim()
    }));
  };

  const ov1 = await overviewNums();
  const acc1 = await accountsText();
  check('accounts tab names the week it is showing',
    acc1.indexOf('Week of') >= 0 && acc1.indexOf(ov1.week.replace(' — Live', '')) >= 0,
    acc1.slice(0, 110));
  check('working account opening matches Overview', acc1.indexOf(ov1.open) >= 0,
    'overview=' + ov1.open);
  check('working account closing matches Overview', acc1.indexOf(ov1.close) >= 0,
    'overview=' + ov1.close);
  check('this-week in matches Overview', acc1.indexOf(ov1.in.replace('-', '')) >= 0, 'overview=' + ov1.in);
  check('this-week out matches Overview', acc1.indexOf(ov1.out.replace('-', '')) >= 0, 'overview=' + ov1.out);

  // Step back a week on Overview; the accounts tab must move with it.
  await s3.page.evaluate(() => { document.querySelectorAll('.nb')[0].click(); stepWeek(-1); });
  await s3.page.waitForTimeout(350);
  const ov2 = await overviewNums();
  const acc2 = await accountsText();
  check('stepping the navigator changes the Overview week', ov2.week !== ov1.week,
    ov1.week + ' -> ' + ov2.week);
  check('the accounts tab followed to the same week',
    acc2.indexOf(ov2.week.replace(' — Live', '')) >= 0, acc2.slice(0, 110));
  check('  ...and its figures changed too', acc2 !== acc1);
  check('  ...working opening now matches the new week', acc2.indexOf(ov2.open) >= 0,
    'overview=' + ov2.open);
  check('  ...working closing now matches the new week', acc2.indexOf(ov2.close) >= 0,
    'overview=' + ov2.close);

  // Every account reports a balance for the selected week, from its own series.
  const perWeek = await s3.page.evaluate(() => {
    const iso = WEEKLY[viewIdx].iso;
    const out = {};
    ACCOUNT_ORDER.forEach(k => {
      const a = ACCOUNTS_LIVE[k];
      out[k] = {
        hasSeries: !!(a && a.weeks && Object.keys(a.weeks).length),
        wk: accountWeek(a, iso)
      };
    });
    return { iso, out };
  });
  ['regulation', 'savings', 'profit'].forEach(k => {
    check('secondary account "' + k + '" carries a per-week series',
      perWeek.out[k] && perWeek.out[k].hasSeries, JSON.stringify(perWeek.out[k]));
    check('  ...and resolves a balance for the selected week',
      perWeek.out[k] && perWeek.out[k].wk !== null, JSON.stringify(perWeek.out[k] && perWeek.out[k].wk));
  });
  check('no page errors while stepping weeks', s3.errors.length === 0, s3.errors.join(' | '));
  await s3.browser.close();

  T.forEach(t => console.log((t.p ? '  PASS  ' : '  FAIL  ') + t.n + (t.d ? '   [' + t.d + ']' : '')));
  const f = T.filter(t => !t.p).length;
  console.log('\n' + (T.length - f) + '/' + T.length + ' passed');
  process.exit(f ? 1 : 0);
})();
