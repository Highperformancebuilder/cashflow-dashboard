const { chromium } = require('playwright');
const isolate = require('./isolate');
// Playwright's own bundled Chromium by default; CHROME_PATH overrides it.
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};

// Stub the Supabase SDK so we can drive auth and realtime deterministically.
const STUB = require('fs').readFileSync(__dirname + '/stub.js', 'utf8');

(async () => {
  const NO_CHART = process.argv.includes('--no-chart');
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage();
  await isolate(page);
  const errors = [];
  page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('CONSOLE: ' + m.text()); });

  if (NO_CHART) await page.addInitScript('window.__noChart = true;');
  await page.route('**/cdn.jsdelivr.net/**', async route => {
    await route.abort();
  });

  await page.addInitScript(STUB);
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });

  const T = [];
  const check = (name, pass, detail = '') => { T.push({ name, pass: !!pass, detail }); };
  const ev = async (fn, arg) => { try { return await page.evaluate(fn, arg); } catch (e) { return { __err: e.message }; } };

  // ---- 1. Login gate --------------------------------------------------
  check('login screen visible', await page.isVisible('#login-screen'));
  check('dashboard hidden before auth', !(await page.isVisible('#dashboard-wrap')));

  // ---- 2. Bad credentials ---------------------------------------------
  await page.fill('#login-email', 'nope@example.com');
  await page.fill('#login-password', 'x');
  await page.click('#login-btn');
  await page.waitForTimeout(300);
  check('bad credentials rejected', await page.isVisible('#login-error'));
  check('dashboard still hidden after failed login', !(await page.isVisible('#dashboard-wrap')));

  // ---- 3. Good credentials --------------------------------------------
  await page.fill('#login-email', 'greg@example.com');
  await page.fill('#login-password', 'x');
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
  check('dashboard visible after login', await page.isVisible('#dashboard-wrap'));

  const badge1 = await page.textContent('#sync-badge');
  check('sync badge populated', !!badge1 && badge1.trim().length > 0, badge1);

  // ---- 4. Live data replaced the hardcoded series ----------------------
  const weekCount = await ev(() => WEEKLY.length);
  check('WEEKLY replaced by fetched data (60 weeks)', weekCount === 60, 'got ' + weekCount);

  const cw = await ev(() => ({ idx: CW_IDX, iso: WEEKLY[CW_IDX].iso, view: viewIdx }));
  const todayIso = new Date().toISOString().slice(0, 10);
  check('CW_IDX derived, not stuck at 50', cw && (cw.idx !== 50 || cw.iso <= todayIso), JSON.stringify(cw));
  check('current week is not in the future', cw && cw.iso <= todayIso, String(cw && cw.iso));
  check('viewIdx follows current week', cw && cw.view === cw.idx, JSON.stringify(cw));

  // ---- 5. Derived series recomputed -----------------------------------
  const derived = await ev(() => {
    const cur = WEEKLY[CW_IDX];
    const fyEnd = (iso) => { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); return m >= 7 ? y + 1 : y; };
    const fy = fyEnd(cur.iso);
    let s = 0, i = 0, o = 0;
    WEEKLY.forEach(w => { if (w.iso <= cur.iso && fyEnd(w.iso) === fy) { s += w.sales; i += w.total_in; o += w.total_out; } });
    return { ytd: { ...YTD }, expect: { sales: Math.round(s), in: Math.round(i), out: Math.round(o) }, months: MONTHLY.length };
  });
  check('YTD recomputed from live weeks',
    derived.ytd && derived.expect && derived.ytd.sales === derived.expect.sales && derived.ytd.in === derived.expect.in && derived.ytd.out === derived.expect.out,
    JSON.stringify(derived));
  check('MONTHLY rebuilt from live weeks', derived.months > 0 && derived.months <= 16, 'months=' + derived.months);

  // ---- 6. Accounts tab is data-driven ---------------------------------
  const acct = await ev(() => {
    const grid = document.getElementById('accounts-grid');
    const total = document.getElementById('accounts-total');
    return { cards: grid ? grid.children.length : 0, totalText: total ? total.textContent.trim().slice(0, 80) : '' };
  });
  check('accounts grid renders 4 cards', acct && acct.cards === 4, 'cards=' + JSON.stringify(acct));
  check('accounts total renders', acct && acct.totalText && acct.totalText.includes('Total Across All Accounts'), String(acct && acct.totalText).slice(0, 60));

  const workingMatches = await ev(() => {
    const closing = WEEKLY[CW_IDX].closing;
    const txt = document.getElementById('accounts-grid').children[0].textContent;
    const want = '$' + Math.abs(Math.round(closing)).toLocaleString();
    return { ok: txt.includes(want), want };
  });
  check('working account shows live closing balance', workingMatches && workingMatches.ok, JSON.stringify(workingMatches));

  // ---- 7. Charts rendered without canvas-reuse errors ------------------
  if (NO_CHART) {
    const fallback = await ev(() => /chart unavailable/i.test(document.body.innerText));
    check('charts degrade gracefully when Chart.js is unavailable', fallback);
  } else {
    const charts = await ev(() => ['fy-chart', 'bal-chart'].map(id => !!Chart.getChart(id)));
    check('overview charts instantiated', Array.isArray(charts) && charts.every(Boolean), JSON.stringify(charts));
  }

  // ---- 8. Tab navigation ----------------------------------------------
  for (const [i, id] of [[1, 'tab-weekly'], [2, 'tab-monthly'], [3, 'tab-clients'], [4, 'tab-accounts']]) {
    await ev(i => document.querySelectorAll('.nb')[i].click(), i);
    await page.waitForTimeout(200);
    check('tab renders: ' + id, await page.isVisible('#' + id));
  }
  await ev(() => document.querySelectorAll('.nb')[0].click());
  await page.waitForTimeout(200);

  // ---- 9. Re-render does not blow up Chart.js -------------------------
  await ev(() => { renderAll(); renderAll(); });
  await page.waitForTimeout(300);
  check('repeated renderAll() is safe (no canvas reuse error)',
    !errors.some(e => /already in use/i.test(e)), errors.filter(e => /already/i.test(e)).join('|'));

  // ---- 10. THE POINT: a realtime push updates the DOM -----------------
  await ev(() => window.__subscribeCb && window.__subscribeCb('SUBSCRIBED'));
  await page.waitForTimeout(200);
  const badgeLive = await page.textContent('#sync-badge');
  check('badge switches to Live on SUBSCRIBED', /Live/.test(badgeLive), badgeLive);
  check('polling stopped once realtime is up', await ev(() => sync.pollTimer === null));

  const before = await ev(() => WEEKLY[CW_IDX].closing);
  const beforeDom = await page.textContent('#ov-close');

  // Simulate Apps Script writing a new snapshot after a sheet edit.
  await ev(() => {
    const snap = {
      version: 1,
      generatedAt: new Date().toISOString(),
      currentWeekIdx: 2,
      currentWeekIso: '2030-01-01',
      weekly: [
        { iso: '2029-12-18', label: '18 Dec 29', opening: 0, sales: 0, other_income: 0, total_in: 0, supplier: 0, total_out: 0, closing: 0 },
        { iso: '2029-12-25', label: '25 Dec 29', opening: 0, sales: 1000, other_income: 0, total_in: 1000, supplier: 0, total_out: 500, closing: 500 },
        { iso: '2030-01-01', label: '01 Jan 30', opening: 500, sales: 777777, other_income: 0, total_in: 777777, supplier: 0, total_out: 1234, closing: 777043 }
      ],
      accounts: {
        working: { label: 'Working Account', opening: 500, closing: 777043 },
        regulation: { label: 'Regulation Account', opening: 11, closing: 22 },
        savings: { label: 'Savings Account', opening: 33, closing: 44, projected12m: 5555 },
        profit: { label: 'Profit Reinvestment', opening: 0, closing: 99, projected12m: 100 }
      }
    };
    window.__realtimeHandlers.forEach(h => h({ new: { sheet_id: 'SHEET123', payload: snap } }));
  });
  await page.waitForTimeout(400);

  const after = await ev(() => ({
    closing: WEEKLY[CW_IDX].closing,
    weeks: WEEKLY.length,
    cw: CW_IDX,
    ovClose: document.getElementById('ov-close').textContent,
    ytdSales: document.getElementById('ytd-sales').textContent,
    label: document.getElementById('cwl').textContent,
    acctTotal: document.getElementById('accounts-total').textContent
  }));

  check('realtime push replaced WEEKLY', after && after.weeks === 3, 'weeks=' + after.weeks);
  check('realtime push moved current week', after && after.cw === 2, 'CW_IDX=' + after.cw);
  check('overview DOM updated from push', after && after.ovClose && after.ovClose.includes('777,043'), String(after && after.ovClose));
  check('overview DOM actually changed', after && after.ovClose !== beforeDom, beforeDom + ' -> ' + after.ovClose);
  check('YTD recomputed on push', after && after.ytdSales && (after.ytdSales.includes('778,777') || after.ytdSales.includes('777,777')), String(after && after.ytdSales));
  check('week label updated', after && after.label && after.label.includes('01 Jan 30'), String(after && after.label));
  check('accounts tab updated from push', after && after.acctTotal && after.acctTotal.includes('777,208'), String(after && after.acctTotal).replace(/\s+/g, ' ').slice(0, 120));

  // ---- 11. Malformed push is rejected, not applied ---------------------
  await ev(() => {
    window.__realtimeHandlers.forEach(h => h({ new: { payload: { version: 99, weekly: [] } } }));
  });
  await page.waitForTimeout(300);
  const afterBad = await ev(() => ({ weeks: WEEKLY.length, banner: document.getElementById('sync-banner').textContent }));
  check('malformed snapshot rejected (data preserved)', afterBad && afterBad.weeks === 3, 'weeks=' + afterBad.weeks);
  check('malformed snapshot surfaces a banner', afterBad && afterBad.banner && afterBad.banner.trim().length > 0, String(afterBad && afterBad.banner).trim().slice(0, 80));

  // ---- 12. Logout tears everything down --------------------------------
  const preLogout = await ev(() => ({
    wrap: document.getElementById('dashboard-wrap').style.display,
    login: document.getElementById('login-screen').style.display,
    banner: document.getElementById('sync-banner').textContent.trim().slice(0, 60)
  }));
  console.log('  [state before logout]', JSON.stringify(preLogout));
  await ev(() => handleLogout());
  await page.waitForTimeout(400);
  check('logout returns to login screen', await page.isVisible('#login-screen'));
  check('logout stops polling', await ev(() => sync.pollTimer === null));
  check('logout removes realtime channel', await ev(() => sync.channel === null));

  await browser.close();

  const fails = T.filter(t => !t.pass);
  T.forEach(t => console.log((t.pass ? '  PASS  ' : '  FAIL  ') + t.name + (t.detail ? '   [' + t.detail + ']' : '')));
  console.log('\n' + (T.length - fails.length) + '/' + T.length + ' passed');
  if (errors.length) { console.log('\nBrowser errors:'); errors.forEach(e => console.log('  ' + e)); }
  process.exit(fails.length ? 1 : 0);
})();
