// Overview hover states: do the cards and controls actually respond, and do
// the restyled buttons still work after losing their inline styles?
const { chromium } = require('playwright');
const isolate = require('./isolate');
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
const STUB = require('fs').readFileSync(__dirname + '/stub.js', 'utf8');

(async () => {
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await isolate(page);
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  await page.addInitScript(STUB);
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });
  await page.fill('#login-email', 'greg@example.com');
  await page.fill('#login-password', 'x');
  await page.click('#login-btn');
  await page.waitForTimeout(1200);

  const T = [];
  const check = (n, c, d = '') => T.push({ n, ok: !!c, d });

  const probe = async (selector, label) => {
    const el = page.locator(selector).first();
    const before = await el.evaluate(e => {
      const s = getComputedStyle(e);
      return { t: s.transform, b: s.borderColor, bg: s.backgroundColor, sh: s.boxShadow, c: s.color, o: s.opacity };
    });
    await el.hover();
    await page.waitForTimeout(280);   // let the .15s transition finish
    const after = await el.evaluate(e => {
      const s = getComputedStyle(e);
      return { t: s.transform, b: s.borderColor, bg: s.backgroundColor, sh: s.boxShadow, c: s.color, o: s.opacity };
    });
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    check(label + ' responds to hover', changed,
      changed ? '' : 'no computed-style change: ' + JSON.stringify(before));
    // move away so the next probe starts clean
    await page.mouse.move(5, 880);
    await page.waitForTimeout(220);
    return { before, after };
  };

  const stat = await probe('#tab-overview .stat', 'Overview stat card');
  check('  ...it lifts', stat.after.t !== 'none' && stat.after.t !== stat.before.t, stat.after.t);
  check('  ...border picks up the accent', stat.after.b !== stat.before.b, stat.before.b + ' -> ' + stat.after.b);

  await probe('#tab-overview .card', 'Overview chart card');
  await probe('#btn-next', 'Week navigator button');
  // The first .nb is the active tab, already at full opacity and accent
  // colour — probe an inactive one, where hover has something to change.
  await probe('.nb:not(.active)', 'Nav tab (inactive)');

  // Read-only tiles must not pretend to be clickable.
  const cursor = await page.locator('#tab-overview .stat').first().evaluate(e => getComputedStyle(e).cursor);
  check('stat tiles keep the default cursor (not clickable)', cursor === 'auto' || cursor === 'default', cursor);
  const navCursor = await page.locator('#btn-next').evaluate(e => getComputedStyle(e).cursor);
  check('navigator button shows a pointer', navCursor === 'pointer', navCursor);

  // The navigator must still work after being restyled. Step BACK: the
  // fixture's last week is the current week, so "next" is correctly a no-op.
  const nav = await page.evaluate(() => ({ view: viewIdx, cw: CW_IDX, len: WEEKLY.length }));
  const beforeLabel = await page.textContent('#cwl');
  await page.click('#btn-prev');
  await page.waitForTimeout(300);
  const afterLabel = await page.textContent('#cwl');
  check('week navigator still steps the week', beforeLabel !== afterLabel,
    JSON.stringify(nav) + '  ' + beforeLabel + ' -> ' + afterLabel);
  check('  ...and viewIdx moved', (await page.evaluate(() => viewIdx)) === nav.view - 1);

  // Weekly filter buttons kept their behaviour after losing inline styles.
  await page.evaluate(() => document.querySelectorAll('.nb')[1].click());
  await page.waitForTimeout(250);
  const filters = await page.evaluate(() => document.querySelectorAll('.wfilter').length);
  check('weekly filter buttons present', filters === 3, 'found ' + filters);
  await probe('.wfilter', 'Weekly filter button');
  const rowsBefore = await page.evaluate(() => document.getElementById('weekly-list').innerHTML.length);
  await page.evaluate(() => document.querySelectorAll('.wfilter')[1].click());   // "All"
  await page.waitForTimeout(300);
  const rowsAfter = await page.evaluate(() => document.getElementById('weekly-list').innerHTML.length);
  check('filter buttons still filter', rowsAfter !== rowsBefore, rowsBefore + ' -> ' + rowsAfter);

  check('no page errors', errs.length === 0, errs.join(' | '));

  await browser.close();
  const fails = T.filter(t => !t.ok);
  T.forEach(t => console.log((t.ok ? '  PASS  ' : '  FAIL  ') + t.n + (t.d ? '   [' + t.d + ']' : '')));
  console.log('\n' + (T.length - fails.length) + '/' + T.length + ' passed');
  process.exit(fails.length ? 1 : 0);
})();
