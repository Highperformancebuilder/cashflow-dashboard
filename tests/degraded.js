const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const fs = require('fs');
const STUB = fs.readFileSync(__dirname + '/stub.js', 'utf8');

const T = [];
const check = (n, p, d='') => T.push({ n, p: !!p, d });

async function scenario(name, pre, body) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
  const page = await browser.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  if (pre) await page.addInitScript(pre);
  await page.addInitScript(STUB);
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });
  const ev = async (fn) => { try { return await page.evaluate(fn); } catch (e) { return { __err: e.message }; } };
  try { await body(page, ev, errs); } catch (e) { check(name + ' — harness', false, e.message); }
  await browser.close();
}

(async () => {

  // --- B. Chart.js CDN blocked: figures must still render -------------------
  await scenario('no-chart', 'window.__noChart = true;', async (page, ev, errs) => {
    await page.fill('#login-email', 'greg@example.com');
    await page.fill('#login-password', 'x');
    await page.click('#login-btn');
    await page.waitForTimeout(1200);
    check('B: dashboard still opens without Chart.js', await page.isVisible('#dashboard-wrap'));
    check('B: weekly data still loaded', (await ev(() => WEEKLY.length)) === 60);
    check('B: overview figures still render', /\d/.test(await page.textContent('#ov-close')));
    check('B: accounts still render', (await ev(() => document.getElementById('accounts-grid').children.length)) === 4);
    check('B: weekly tab still renders', (await ev(() => document.getElementById('weekly-list').innerHTML.length)) > 500);
    check('B: chart placeholder shown', await ev(() => /chart unavailable/i.test(document.body.innerText)));
    check('B: no unhandled page errors', errs.length === 0, errs.join('|'));
  });

  // --- C. Supabase SDK blocked: fail loudly, not silently -------------------
  await scenario('no-supabase', 'window.__noSupabase = true;', async (page, ev, errs) => {
    await page.waitForTimeout(600);
    check('C: login error surfaced when SDK missing', await page.isVisible('#login-error'));
    const msg = await page.textContent('#login-error');
    check('C: message explains the failure', /unavailable|authentication/i.test(msg), msg.slice(0, 70));
    check('C: sign-in button disabled', await ev(() => document.getElementById('login-btn').disabled));
    check('C: accounts still rendered from fallback',
      (await ev(() => document.getElementById('accounts-grid').children.length)) === 4);
    const fatal = errs.filter(e => /is not defined/.test(e));
    check('C: no fatal "supabase is not defined"', fatal.length === 0, fatal.join('|'));
  });

  // --- D. RLS denies the client lookup: must FAIL CLOSED --------------------
  await scenario('rls-denied', 'window.__clientError = true;', async (page, ev) => {
    await page.fill('#login-email', 'greg@example.com');
    await page.fill('#login-password', 'x');
    await page.click('#login-btn');
    await page.waitForTimeout(1200);
    const banner = await page.textContent('#sync-banner');
    check('D: lookup failure surfaces a banner', banner.trim().length > 0, banner.trim().slice(0, 70));
    check('D: fails CLOSED — no sheet adopted', (await ev(() => sync.sheetId)) === null);
    check('D: no realtime channel opened', (await ev(() => sync.channel)) === null);
    check('D: no polling started', (await ev(() => sync.pollTimer)) === null);
    check('D: badge shows an error state', /verified|error|⚠/i.test(await page.textContent('#sync-badge')));
  });

  // --- E. Login with no sheet linked ---------------------------------------
  await scenario('no-sheet', 'window.__clientRow = null;', async (page, ev) => {
    await page.fill('#login-email', 'greg@example.com');
    await page.fill('#login-password', 'x');
    await page.click('#login-btn');
    await page.waitForTimeout(1200);
    const banner = await page.textContent('#sync-banner');
    check('E: explains that no sheet is connected', /no spreadsheet is connected/i.test(banner), banner.trim().slice(0, 70));
    check('E: points the user at the Connect tab', /connect/i.test(banner), banner.trim().slice(0, 70));
    check('E: does not adopt a default sheet', (await ev(() => sync.sheetId)) === null);
    check('E: dashboard still usable with sample data', await page.isVisible('#dashboard-wrap'));
  });

  T.forEach(t => console.log((t.p ? '  PASS  ' : '  FAIL  ') + t.n + (t.d ? '   [' + t.d + ']' : '')));
  const f = T.filter(t => !t.p).length;
  console.log('\n' + (T.length - f) + '/' + T.length + ' passed');
  process.exit(f ? 1 : 0);
})();
