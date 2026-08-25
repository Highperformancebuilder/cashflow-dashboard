// Connect tab: pasting a sheet link, validation, the 5-second update loop,
// and proof that the existing dashboard tabs keep working throughout.
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const http = require('http');
const STUB = require('fs').readFileSync(__dirname + '/stub.js', 'utf8');

const SHEET = '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c';
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/' + SHEET + '/edit?usp=sharing';

const T = [];
const check = (n, p, d = '') => T.push({ n, p: !!p, d });
const mutate = (v) => new Promise(r => http.get('http://localhost:8099/__mutate?v=' + v, res => { res.resume(); res.on('end', r); }));

(async () => {
  await mutate(0);   // reset the fixture so re-runs are independent

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

  // Signed in, but with no sheet on the account — the Connect-tab path.
  await page.addInitScript('window.__clientRow = null;');
  await page.addInitScript(STUB);
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });
  const ev = async (fn, a) => { try { return await page.evaluate(fn, a); } catch (e) { return { __err: e.message }; } };

  await page.fill('#login-email', 'greg@example.com');
  await page.fill('#login-password', 'x');
  await page.click('#login-btn');
  await page.waitForTimeout(900);

  // --- 1. The tab exists and prompts for a connection ----------------------
  const navLabels = await ev(() => Array.from(document.querySelectorAll('.nb')).map(b => b.textContent.trim()));
  check('Connect appears in the nav', Array.isArray(navLabels) && navLabels.includes('Connect'), JSON.stringify(navLabels));
  check('unconnected state explains itself', /connect/i.test(await page.textContent('#sync-banner')));

  await page.evaluate(() => document.querySelectorAll('.nb')[5].click());
  await page.waitForTimeout(250);
  check('Connect tab opens', await page.isVisible('#tab-connect'));
  check('input field present', await page.isVisible('#connect-url'));
  check('Connect button present', await page.isVisible('#connect-btn'));
  check('no "currently connected" panel before connecting',
    (await ev(() => document.getElementById('connect-current').innerHTML.trim())) === '');

  // --- 2. Rubbish input is rejected without touching the dashboard ---------
  const baselineWeeks = await ev(() => WEEKLY.length);
  await page.fill('#connect-url', 'https://evil.example.com/not-a-sheet');
  await page.click('#connect-btn');
  await page.waitForTimeout(500);
  check('bad link shows an error', /not a google sheets/i.test(await page.textContent('#connect-result')),
    (await page.textContent('#connect-result')).trim().slice(0, 60));
  check('bad link leaves data untouched', (await ev(() => WEEKLY.length)) === baselineWeeks);
  check('bad link adopts no source', (await ev(() => sync.source)) === null);

  // --- 3. A well-formed link to an unreadable sheet ------------------------
  await page.fill('#connect-url', 'https://docs.google.com/spreadsheets/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit');
  await page.click('#connect-btn');
  await page.waitForTimeout(700);
  const shareMsg = await page.textContent('#connect-result');
  check('unreadable sheet suggests the sharing fix', /anyone with the link/i.test(shareMsg), shareMsg.trim().slice(0, 80));
  check('failed connect adopts no source', (await ev(() => sync.source)) === null);

  // --- 4. The real thing ---------------------------------------------------
  await page.fill('#connect-url', SHEET_URL);
  await page.click('#connect-btn');
  await page.waitForTimeout(1200);
  const okMsg = await page.textContent('#connect-result');
  check('connect succeeds', /connected/i.test(okMsg), okMsg.trim().slice(0, 90));
  check('reports the week count', /\d+\s*weeks/i.test(okMsg), okMsg.trim().slice(0, 90));
  check('source adopted', (await ev(() => sync.source && sync.source.id)) === SHEET);
  check('data actually loaded', (await ev(() => WEEKLY.length)) === 60);
  check('input cleared after success', (await ev(() => document.getElementById('connect-url').value)) === '');
  check('"currently connected" panel appears', /currently connected/i.test(await page.textContent('#tab-connect')));
  check('panel offers Disconnect', await page.isVisible('button.cbtn.ghost'));
  check('connection persisted to localStorage',
    (await ev(() => { const r = localStorage.getItem('gj_cashflow_source'); return r ? JSON.parse(r).id : null; })) === SHEET);
  check('sync banner cleared on success', (await page.textContent('#sync-banner')).trim() === '');

  // --- 5. THE EXISTING DASHBOARD MUST NOT BREAK ---------------------------
  const tabs = [[0, 'tab-overview'], [1, 'tab-weekly'], [2, 'tab-monthly'], [3, 'tab-clients'], [4, 'tab-accounts']];
  for (const [i, id] of tabs) {
    await page.evaluate(i => document.querySelectorAll('.nb')[i].click(), i);
    await page.waitForTimeout(200);
    const filled = await ev(id => {
      const el = document.getElementById(id);
      return el && el.offsetParent !== null && el.innerText.trim().length > 120;
    }, id);
    check('still renders after connect: ' + id, filled === true, String(filled));
  }
  check('overview shows a real figure', /\$[\d,]+/.test(await page.textContent('#ov-close')), await page.textContent('#ov-close'));
  check('accounts still 4 cards', (await ev(() => document.getElementById('accounts-grid').children.length)) === 4);
  check('clients tab still populated', (await ev(() => document.getElementById('client-list').children.length)) > 0);
  check('charts still instantiated', (await ev(() => !!Chart.getChart('fy-chart') && !!Chart.getChart('bal-chart'))) === true);

  // --- 6. A sheet edit reaches the dashboard within ~5 seconds ------------
  await page.evaluate(() => document.querySelectorAll('.nb')[0].click());
  await page.waitForTimeout(200);
  const before = await ev(() => document.getElementById('ov-in').textContent);
  await mutate(7777);                       // "somebody edits the spreadsheet"
  const t0 = Date.now();
  let after = before, elapsed = null;
  for (let i = 0; i < 40; i++) {            // poll the DOM for up to ~8s
    await page.waitForTimeout(200);
    after = await ev(() => document.getElementById('ov-in').textContent);
    if (after !== before) { elapsed = Date.now() - t0; break; }
  }
  check('sheet edit reaches the dashboard', after !== before, before + ' -> ' + after);
  check('within 5 seconds (target)', elapsed !== null && elapsed <= 5500, elapsed === null ? 'never' : elapsed + 'ms');
  check('no manual refresh was needed', true);

  // --- 7. A bad link must not destroy a working connection ----------------
  await page.evaluate(() => document.querySelectorAll('.nb')[5].click());
  await page.waitForTimeout(200);
  const liveWeeks = await ev(() => WEEKLY.length);
  await page.fill('#connect-url', 'total nonsense');
  await page.click('#connect-btn');
  await page.waitForTimeout(600);
  check('bad link preserves the live connection', (await ev(() => sync.source && sync.source.id)) === SHEET);
  check('bad link preserves loaded data', (await ev(() => WEEKLY.length)) === liveWeeks);

  // --- 8. Disconnect -------------------------------------------------------
  await page.evaluate(() => disconnectSheet());
  await page.waitForTimeout(400);
  check('disconnect clears the source', (await ev(() => sync.source)) === null);
  check('disconnect stops polling', (await ev(() => sync.pollTimer)) === null);
  check('disconnect clears localStorage', (await ev(() => localStorage.getItem('gj_cashflow_source'))) === null);
  check('disconnect explains the state', /no spreadsheet is connected/i.test(await page.textContent('#sync-banner')));

  // --- 9. A stored connection survives a reload --------------------------
  await page.fill('#connect-url', SHEET_URL);
  await page.click('#connect-btn');
  await page.waitForTimeout(1200);
  check('reconnected before reload', (await ev(() => sync.source && sync.source.id)) === SHEET);

  await page.reload({ waitUntil: 'networkidle' });
  await page.fill('#login-email', 'greg@example.com');
  await page.fill('#login-password', 'x');
  await page.click('#login-btn');
  await page.waitForTimeout(1500);
  check('stored connection restored after reload', (await ev(() => sync.source && sync.source.id)) === SHEET);
  check('data reloaded automatically', (await ev(() => WEEKLY.length)) === 60);
  check('no re-paste required', (await page.textContent('#sync-banner')).trim() === '');

  check('no unhandled page errors throughout', errors.length === 0, errors.join(' | '));

  await browser.close();
  T.forEach(t => console.log((t.p ? '  PASS  ' : '  FAIL  ') + t.n + (t.d ? '   [' + t.d + ']' : '')));
  const f = T.filter(t => !t.p).length;
  console.log('\n' + (T.length - f) + '/' + T.length + ' passed');
  process.exit(f ? 1 : 0);
})();
