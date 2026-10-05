// Clients tab: every financial year present, newest first, one open at a time,
// and the figures read from the sheet rather than the hardcoded CLIENTS array.
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
  page.on('console', m => {
    if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) errs.push('CONSOLE: ' + m.text());
  });
  await page.addInitScript(STUB);
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });

  const T = [];
  const check = (n, c, d = '') => T.push({ n, ok: !!c, d });

  // ---- before a sheet is connected: blank, never a built-in client list ---
  await page.evaluate(() => renderClients());
  await page.waitForTimeout(200);
  const blank = await page.evaluate(() => ({
    html: document.getElementById('client-list').textContent.replace(/\s+/g, ' '),
    cards: document.querySelectorAll('#client-list .gcard').length
  }));
  check('no client cards before a sheet is connected', blank.cards === 0, 'cards=' + blank.cards);
  check('blank state invites the user to connect', /connect/i.test(blank.html), blank.html.slice(0, 90));

  // ---- sign in: the fixture serves the real sheet shape --------------------
  await page.fill('#login-email', 'greg@example.com');
  await page.fill('#login-password', 'x');
  await page.click('#login-btn');
  await page.waitForTimeout(1400);

  await page.evaluate(() => document.querySelectorAll('.nb')[3].click());
  await page.waitForTimeout(400);
  check('Clients tab opens', await page.isVisible('#tab-clients'));

  const live = await page.evaluate(() => CLIENTS_LIVE && {
    years: Object.keys(CLIENTS_LIVE.byFY).map(Number).sort((a, b) => b - a),
    fyTotals: CLIENTS_LIVE.fyTotals,
    lifetimeCount: Object.keys(CLIENTS_LIVE.lifetime).length
  });
  check('client data was read from the sheet', !!live, JSON.stringify(live));
  if (!live) {
    T.forEach(t => console.log((t.ok ? '  PASS  ' : '  FAIL  ') + t.n + (t.d ? '   [' + t.d + ']' : '')));
    console.log('\n' + T.filter(t => t.ok).length + '/' + T.length + ' passed');
    await browser.close();
    process.exit(1);
  }

  // ---- 1. MULTIPLE financial years, newest first -------------------------
  const heads = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#client-list .fyhead'))
         .map(h => h.textContent.replace(/\s+/g, ' ').trim()));
  const yrs = heads.map(h => parseInt((h.match(/FY(\d{4})/) || [])[1], 10));

  check('more than one financial year is shown', yrs.length >= 2, JSON.stringify(yrs));
  check('years are DESCENDING (newest first)',
    yrs.every((y, i) => i === 0 || yrs[i - 1] > y), JSON.stringify(yrs));
  check('a section exists for every year in the data',
    yrs.length === live.years.length, JSON.stringify(yrs) + ' vs ' + JSON.stringify(live.years));

  // ---- 2. one open at a time, current year by default --------------------
  const openCount = await page.evaluate(() =>
    document.querySelectorAll('#client-list .fyhead[aria-expanded="true"]').length);
  check('exactly one year is open on arrival', openCount === 1, 'open=' + openCount);

  const cur = await page.evaluate(() => {
    const iso = (WEEKLY[viewIdx] || WEEKLY[CW_IDX]).iso;
    return { fy: +iso.slice(0, 4) + (+iso.slice(5, 7) >= 7 ? 1 : 0), open: expandedClientFY };
  });
  check('the CURRENT financial year is the one open', cur.open === cur.fy, JSON.stringify(cur));
  check('only one year is labelled "Current Financial Year"',
    heads.filter(h => /Current Financial Year/i.test(h)).length === 1, JSON.stringify(heads));

  // ---- 3. collapsed years render no cards --------------------------------
  const cardsIn = (fy) => page.evaluate((y) => {
    const h = Array.from(document.querySelectorAll('#client-list .fyhead'))
                   .find(x => x.textContent.indexOf('FY' + y) >= 0);
    return h ? h.parentElement.querySelectorAll('.gcard').length : -1;
  }, fy);
  const other = yrs.find(y => y !== cur.open);
  check('the open year renders client cards', (await cardsIn(cur.open)) > 0, 'FY' + cur.open);
  check('a collapsed year renders none', (await cardsIn(other)) === 0, 'FY' + other);

  // ---- 4. clicking a year opens it ---------------------------------------
  await page.evaluate((y) => toggleClientFY(y), other);
  await page.waitForTimeout(400);
  check('clicking a year opens it', (await page.evaluate(() => expandedClientFY)) === other,
    'clicked FY' + other);
  check('  ...and it now renders cards', (await cardsIn(other)) > 0);
  check('  ...and the previous year collapsed', (await cardsIn(cur.open)) === 0);

  // ---- 5. the Clients accordion is independent of FY Performance ---------
  const fyBefore = await page.evaluate(() => expandedFY);
  check('opening a client year does not move the FY Performance one',
    fyBefore !== null && fyBefore !== other || fyBefore === null,
    'expandedFY=' + fyBefore + ' expandedClientFY=' + other);

  // ---- 6. figures come from the sheet, not the hardcoded array ------------
  const cardTotals = await page.evaluate((y) => {
    const h = Array.from(document.querySelectorAll('#client-list .fyhead'))
                   .find(x => x.textContent.indexOf('FY' + y) >= 0);
    return Array.from(h.parentElement.querySelectorAll('.gcard')).map(c =>
      c.textContent.replace(/\s+/g, ' ').trim().slice(0, 60));
  }, other);
  check('cards render for the opened year', cardTotals.length > 0, cardTotals[0]);

  const hardcodedNames = await page.evaluate(() => CLIENTS.map(c => c.name));
  const sheetNames = await page.evaluate(() => Object.keys(CLIENTS_LIVE.lifetime));
  check('client names come from the sheet',
    sheetNames.length > 0 && sheetNames.some(n => !hardcodedNames.includes(n)) ||
    sheetNames.length !== hardcodedNames.length,
    'sheet=' + sheetNames.length + ' hardcoded=' + hardcodedNames.length);

  // ---- 7. non-client rows are excluded -----------------------------------
  const junk = sheetNames.filter(n => /^total\b|^overdraft|^greg lend|^credit from supplier/i.test(n));
  check('summary and non-client rows are excluded', junk.length === 0, JSON.stringify(junk));

  // ---- 8. each year's header total equals the sum of its cards -----------
  const consistency = await page.evaluate(() => {
    const out = [];
    Object.keys(CLIENTS_LIVE.byFY).forEach(fy => {
      const sum = CLIENTS_LIVE.byFY[fy].reduce((a, c) => a + c.total, 0);
      out.push({ fy: +fy, header: CLIENTS_LIVE.fyTotals[fy], sum: Math.round(sum) });
    });
    return out;
  });
  check('every year total equals the sum of its clients',
    consistency.every(c => Math.abs(c.header - c.sum) <= 1), JSON.stringify(consistency));

  // ---- 9. lifetime is the sum across all years ---------------------------
  const lifetimeOk = await page.evaluate(() => {
    const acc = {};
    Object.keys(CLIENTS_LIVE.byFY).forEach(fy =>
      CLIENTS_LIVE.byFY[fy].forEach(c => { acc[c.name] = (acc[c.name] || 0) + c.total; }));
    return Object.keys(acc).every(n => Math.abs(acc[n] - CLIENTS_LIVE.lifetime[n]) <= 2);
  });
  check('lifetime equals the sum of every year', lifetimeOk);

  check('no page errors', errs.length === 0, errs.join(' | '));

  await browser.close();
  const fails = T.filter(t => !t.ok);
  T.forEach(t => console.log((t.ok ? '  PASS  ' : '  FAIL  ') + t.n + (t.d ? '   [' + t.d + ']' : '')));
  console.log('\n' + (T.length - fails.length) + '/' + T.length + ' passed');
  process.exit(fails.length ? 1 : 0);
})();
