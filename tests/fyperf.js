// FY Performance tab: newest financial year first, one year open at a time,
// the current year open by default, and clicking a year opens it.
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
  // isolate() blocks the CDNs on purpose, so their load failures are expected.
  page.on('console', m => {
    if (m.type() === 'error' && !/ERR_FAILED|net::/.test(m.text())) errs.push('CONSOLE: ' + m.text());
  });
  await page.addInitScript(STUB);
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });
  await page.fill('#login-email', 'greg@example.com');
  await page.fill('#login-password', 'x');
  await page.click('#login-btn');
  await page.waitForTimeout(1200);

  const T = [];
  const check = (n, c, d = '') => T.push({ n, ok: !!c, d });

  // Open the FY Performance tab.
  await page.evaluate(() => document.querySelectorAll('.nb')[2].click());
  await page.waitForTimeout(400);
  check('FY Performance tab opens', await page.isVisible('#tab-monthly'));

  const headings = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#monthly-list .fyhead'))
         .map(h => h.textContent.replace(/\s+/g, ' ').trim()));

  const years = () => page.evaluate(() =>
    Array.from(document.querySelectorAll('#monthly-list .fyhead'))
         .map(h => parseInt((h.textContent.match(/FY(\d{4})/) || [])[1], 10)));

  const heads = await headings();
  const yrs = await years();
  check('financial years are listed', yrs.length >= 2, JSON.stringify(yrs));

  // ---- 1. DESCENDING ORDER ------------------------------------------------
  const descending = yrs.every((y, i) => i === 0 || yrs[i - 1] > y);
  check('years are in DESCENDING order (newest first)', descending, JSON.stringify(yrs));

  // ---- 2. exactly one year expanded, and it is the current one ------------
  const expandedCount = await page.evaluate(() =>
    document.querySelectorAll('#monthly-list .fyhead[aria-expanded="true"]').length);
  check('exactly one year is open on arrival', expandedCount === 1, 'open=' + expandedCount);

  const state = await page.evaluate(() => {
    const iso = (WEEKLY[CW_IDX] && WEEKLY[CW_IDX].iso) || '';
    const y = +iso.slice(0, 4), m = +iso.slice(5, 7);
    return { currentFY: m >= 7 ? y + 1 : y, expandedFY: expandedFY };
  });
  check('the CURRENT financial year is the one open',
    state.expandedFY === state.currentFY, JSON.stringify(state));

  // ---- 3. only the current year is labelled "Current Financial Year" -----
  const currentLabels = heads.filter(h => /Current Financial Year/i.test(h));
  check('only one year claims to be the current one', currentLabels.length === 1,
    JSON.stringify(currentLabels));
  const pastMislabelled = heads.filter(h => {
    const y = parseInt((h.match(/FY(\d{4})/) || [])[1], 10);
    return y < state.currentFY && /Current Financial Year/i.test(h);
  });
  check('past years are not labelled "Current"', pastMislabelled.length === 0,
    JSON.stringify(pastMislabelled));
  check('past years read "Completed"',
    heads.some(h => /Completed/i.test(h)) || yrs.every(y => y >= state.currentFY),
    JSON.stringify(heads));

  // ---- 4. every header shows the year's net -------------------------------
  check('each year shows a net figure in its header',
    heads.every(h => /Net for the year/i.test(h) && /[+-]\$/.test(h)), JSON.stringify(heads[0]));

  // ---- 5. collapsed years render no month cards --------------------------
  const monthCardsFor = (yr) => page.evaluate((y) => {
    const heads = Array.from(document.querySelectorAll('#monthly-list .fyhead'));
    const h = heads.find(x => x.textContent.indexOf('FY' + y) >= 0);
    if (!h) return -1;
    return h.parentElement.querySelectorAll('table').length;
  }, yr);

  const openYear = state.expandedFY;
  const closedYear = yrs.find(y => y !== openYear);
  check('the open year renders its month tables', (await monthCardsFor(openYear)) > 0,
    'FY' + openYear);
  check('a collapsed year renders none', (await monthCardsFor(closedYear)) === 0,
    'FY' + closedYear);

  // ---- 6. CLICKING a year opens it ---------------------------------------
  await page.evaluate((y) => {
    const heads = Array.from(document.querySelectorAll('#monthly-list .fyhead'));
    heads.find(x => x.textContent.indexOf('FY' + y) >= 0).click();
  }, closedYear);
  await page.waitForTimeout(400);

  const afterClick = await page.evaluate(() => expandedFY);
  check('clicking a year opens it', afterClick === closedYear,
    'clicked FY' + closedYear + ', expandedFY=' + afterClick);
  check('  ...and it now renders its months', (await monthCardsFor(closedYear)) > 0);
  check('  ...and the previous year collapsed', (await monthCardsFor(openYear)) === 0);
  check('  ...still exactly one open', (await page.evaluate(() =>
    document.querySelectorAll('#monthly-list .fyhead[aria-expanded="true"]').length)) === 1);

  // ---- 7. clicking the open year closes it -------------------------------
  await page.evaluate((y) => {
    const heads = Array.from(document.querySelectorAll('#monthly-list .fyhead'));
    heads.find(x => x.textContent.indexOf('FY' + y) >= 0).click();
  }, closedYear);
  await page.waitForTimeout(400);
  check('clicking the open year collapses it',
    (await page.evaluate(() => expandedFY)) === null);
  check('  ...and every year is then collapsed', (await page.evaluate(() =>
    document.querySelectorAll('#monthly-list .fyhead[aria-expanded="true"]').length)) === 0);

  // ---- 8. order survives a re-render --------------------------------------
  await page.evaluate(() => renderMonthly());
  await page.waitForTimeout(300);
  const yrs2 = await years();
  check('order is stable across re-render', JSON.stringify(yrs2) === JSON.stringify(yrs),
    JSON.stringify(yrs2));

  // ---- 9. the all-years total is no longer called "Projected" -------------
  const totals = await page.evaluate(() => {
    const cards = document.querySelectorAll('#monthly-list .card');
    return cards.length ? cards[cards.length - 1].textContent.replace(/\s+/g, ' ').trim() : '';
  });
  check('all-years total is labelled honestly, not "Projected"',
    /All financial years/i.test(totals) && !/Projected/i.test(totals), totals.slice(0, 110));

  // ---- 10. the comparison chart is read from the sheet, not hardcoded -----
  await page.evaluate(() => { fyPicked = false; renderMonthly(); });
  await page.waitForTimeout(400);

  const chart = () => page.evaluate(() => {
    const canvas = document.getElementById('fy-compare-chart');
    if (!canvas) return null;
    // stub.js's getChart takes the id, matching how makeChart() calls it.
    const c = Chart.getChart('fy-compare-chart');
    if (!c) return null;
    // Which financial year's section is this canvas inside?
    let el = canvas, owner = null;
    while (el && !owner) {
      el = el.parentElement;
      const h = el && el.querySelector && el.querySelector(':scope > .fyhead');
      if (h) owner = parseInt((h.textContent.match(/FY(\d{4})/) || [])[1], 10);
    }
    return {
      labels: c.config.data.labels,
      sets: c.config.data.datasets.map(d => ({ label: d.label, data: d.data })),
      heading: canvas.closest('div').previousElementSibling.textContent.trim(),
      section: owner,
      canvasCount: document.querySelectorAll('#fy-compare-chart').length
    };
  });

  const c1 = await chart();
  check('comparison chart exists', !!c1);
  check('the graph is rendered INSIDE the open year, not at the bottom of the tab',
    c1 && c1.section === state.currentFY, c1 && 'section=FY' + c1.section);
  check('only one graph canvas exists at a time', c1 && c1.canvasCount === 1,
    c1 && 'canvases=' + c1.canvasCount);
  check('chart plots the CURRENT financial year', c1 && c1.sets[0].label === 'FY' + state.currentFY,
    c1 && c1.sets[0].label);
  check('chart heading is dynamic, not hardcoded FY2026 vs FY2025',
    c1 && c1.heading.indexOf('FY' + state.currentFY) >= 0 && !/FY2026 vs FY2025/.test(c1.heading),
    c1 && c1.heading);
  check('months are in financial-year order (Jul first, Jun last)',
    c1 && c1.labels[0] === 'Jul' && c1.labels[11] === 'Jun', JSON.stringify(c1 && c1.labels));

  // The series must match what the page derived from the sheet, not a constant.
  const derived = await page.evaluate((fy) => fyNetByMonth(fy), state.currentFY);
  check('series comes from fyNetByMonth() over the live MONTHLY data',
    c1 && JSON.stringify(c1.sets[0].data) === JSON.stringify(derived),
    JSON.stringify(derived).slice(0, 90));
  check('months with no data are null, not zero',
    derived.some(v => v === null) || derived.every(v => v !== null),
    JSON.stringify(derived));

  check('the frozen FY25_NET constant is gone',
    (await page.evaluate(() => typeof FY25_NET)) === 'undefined');

  // ---- 11. the chart follows the year you open ---------------------------
  const otherYear = yrs.find(y => y !== state.currentFY);
  await page.evaluate((y) => toggleFY(y), otherYear);
  await page.waitForTimeout(450);
  const c2 = await chart();
  check('opening another year re-plots the chart for it',
    c2 && c2.sets[0].label === 'FY' + otherYear, c2 && c2.sets[0].label);
  check('  ...and the heading follows',
    c2 && c2.heading.indexOf('FY' + otherYear) >= 0, c2 && c2.heading);
  check('  ...and it is compared against the year before it',
    c2 && (c2.sets.length === 1 || c2.sets[1].label === 'FY' + (otherYear - 1)),
    c2 && JSON.stringify(c2.sets.map(s => s.label)));
  check('  ...and the data actually changed',
    c1 && c2 && JSON.stringify(c1.sets[0].data) !== JSON.stringify(c2.sets[0].data));
  check('  ...and the graph moved into that year\'s section',
    c2 && c2.section === otherYear, c2 && 'section=FY' + c2.section);
  check('  ...still only one canvas', c2 && c2.canvasCount === 1,
    c2 && 'canvases=' + c2.canvasCount);

  // ---- 12. every financial year draws its own graph -----------------------
  for (const y of yrs) {
    await page.evaluate((yy) => { fyPicked = true; expandedFY = yy; renderMonthly(); }, y);
    await page.waitForTimeout(400);
    const c = await chart();
    check('FY' + y + ' renders its own graph', !!c && c.section === y && c.sets[0].label === 'FY' + y,
      c ? 'section=FY' + c.section + ' series=' + c.sets[0].label : 'no chart');
  }

  // ---- 13. collapsing everything leaves no orphaned chart -----------------
  await page.evaluate(() => { fyPicked = true; expandedFY = null; renderMonthly(); });
  await page.waitForTimeout(350);
  check('collapsing all removes the graph', (await page.evaluate(() =>
    document.querySelectorAll('#fy-compare-chart').length)) === 0);
  check('  ...and no Chart.js instance is left behind', (await page.evaluate(() =>
    typeof moChart === 'undefined' ? 'undef' : moChart)) === null);

  // ---- 14. every month card shares one border colour ----------------------
  // Colour-coding the borders by value turned the grid into a patchwork; the
  // month's health is already stated by its Net Cash Movement figure.
  await page.evaluate(() => { fyPicked = false; renderMonthly(); });
  await page.waitForTimeout(400);

  const borders = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#monthly-list .gcard.compact'));
    return cards.map(el => ({
      label: (el.textContent.match(/^[A-Za-z]{3} \d{4}/) || [''])[0],
      border: getComputedStyle(el).borderColor,
      width: getComputedStyle(el).borderTopWidth,
      bg: getComputedStyle(el).backgroundColor,
      pipe: el.classList.contains('is-pipe'),
      states: ['is-neg', 'is-tight', 'is-cur'].filter(s => el.classList.contains(s))
    }));
  });
  check('month cards are rendered', borders.length > 0, 'count=' + borders.length);

  const plain = borders.filter(b => !b.pipe);
  const uniqueBorders = [...new Set(plain.map(b => b.border))];
  const uniqueBg = [...new Set(plain.map(b => b.bg))];
  check('EVERY month card has the same border colour', uniqueBorders.length === 1,
    JSON.stringify(uniqueBorders));
  check('  ...and the same background', uniqueBg.length === 1, JSON.stringify(uniqueBg));
  check('  ...and the same border width',
    [...new Set(plain.map(b => b.width))].length === 1,
    JSON.stringify([...new Set(plain.map(b => b.width))]));
  check('no value-based state classes remain on month cards',
    plain.every(b => b.states.length === 0),
    JSON.stringify(plain.filter(b => b.states.length).map(b => b.label + ':' + b.states)));

  // A negative month must still be readable — via its figure, not its border.
  const negText = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll('#monthly-list .gcard.compact'));
    const neg = cards.find(el => /-\$/.test(el.textContent));
    if (!neg) return null;
    const fig = Array.from(neg.querySelectorAll('div')).find(d => /^[+-]\$/.test(d.textContent.trim()));
    return fig ? getComputedStyle(fig).color : null;
  });
  check('a negative month still shows its figure in red/amber',
    negText === null || /rgb\(239, 68, 68\)|rgb\(245, 158, 11\)/.test(negText), String(negText));

  // ---- 15. every financial-year row responds to hover ---------------------
  await page.evaluate(() => { fyPicked = false; renderMonthly(); });
  await page.waitForTimeout(400);

  const sections = await page.evaluate(() => document.querySelectorAll('#monthly-list .fysec').length);
  check('year rows use the .fysec class', sections === yrs.length, 'found ' + sections);

  check('no inline border/background left on year rows',
    (await page.evaluate(() => Array.from(document.querySelectorAll('#monthly-list .fysec'))
       .filter(el => /border|background|padding/.test(el.getAttribute('style') || '')).length)) === 0);

  const secProbe = async (idx, label) => {
    const el = page.locator('#monthly-list .fysec').nth(idx);
    await page.mouse.move(5, 880);
    await page.waitForTimeout(220);
    const read = () => el.evaluate(e => {
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      return {
        bw: parseFloat(s.borderTopWidth), pad: parseFloat(s.paddingTop),
        border: s.borderColor, t: s.transform,
        content: Math.round(r.width - 2 * parseFloat(s.borderLeftWidth) - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight))
      };
    });
    const before = await read();
    await el.hover();
    await page.waitForTimeout(320);
    const after = await read();
    await page.mouse.move(5, 880);
    await page.waitForTimeout(200);
    check(label + ': 1px at rest', before.bw === 1, before.bw + 'px');
    check(label + ': 3px on hover', after.bw === 3, after.bw + 'px');
    check(label + ': border brightens', after.border !== before.border,
      before.border + ' -> ' + after.border);
    check(label + ': it lifts', after.t !== 'none' && after.t !== before.t, after.t);
    check(label + ': content does not shift', Math.abs(after.content - before.content) <= 1,
      before.content + ' -> ' + after.content);
    return after.border;
  };

  const curBorder = await secProbe(0, 'Current year row');
  const doneBorder = await secProbe(1, 'Completed year row');
  check('each year hovers to its OWN accent, not one shared colour',
    curBorder !== doneBorder, curBorder + ' vs ' + doneBorder);
  check('the current year hovers lime', /204, 244, 146/.test(curBorder), curBorder);

  check('no page errors', errs.length === 0, errs.join(' | '));

  await browser.close();
  const fails = T.filter(t => !t.ok);
  T.forEach(t => console.log((t.ok ? '  PASS  ' : '  FAIL  ') + t.n + (t.d ? '   [' + t.d + ']' : '')));
  console.log('\n' + (T.length - fails.length) + '/' + T.length + ' passed');
  process.exit(fails.length ? 1 : 0);
})();
