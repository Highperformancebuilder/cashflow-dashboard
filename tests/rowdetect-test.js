// Exercise the row-detection and URL-candidate logic against layouts that
// mirror the real spreadsheet, including gviz's row-trimming behaviour.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
const grab = (name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let d = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { d++; started = true; }
    else if (src[j] === '}') { d--; if (started && d === 0) return src.slice(i, j + 1); }
  }
};
const pick = (re) => src.match(re)[0];
const SNAPSHOT_VERSION = 1;
const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WORKING_SHEET_NAME = 'Business Working Account';
// One eval so the consts share a scope with the functions that close over them.
eval([
  pick(/const CSV_ROW = \{[^}]*\};/),
  pick(/const ROW_OFFSET = \{[\s\S]*?\n\};/),
  grab('csvNum'), grab('csvDate'),
  grab('normLabel'),
  pick(/const ROW_LABELS = \{[\s\S]*?\n\};/),
  pick(/const ROW_KEYS = [^\n]*/),
  pick(/const FIGURE_NAMES = \{[\s\S]*?\n\};/),
  pick(/const LABEL_SCAN_COLS = \d+;/),
  pick(/const TAB_ALIASES = \{[\s\S]*?\n\};/),
  grab('rowLabelRank'), grab('rowDataCount'), grab('resolveRows'),
  grab('findWeekDateRow'), grab('weekHasData'), grab('pickCurrentWeek'),
  grab('snapshotFromRows'), grab('accountFromRows'),
  grab('candidateUrls'), grab('describeEndpoint')
].join('\n'));

let pass = 0, fail = 0;
const t = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); } };

// Build a grid shaped like the real sheet: labels in col B, weeks from col ~132.
function buildRealisticGrid({ leadingBlankRows = 0, firstDataCol = 131, weeks = 20 } = {}) {
  const totalRows = 217 + leadingBlankRows;
  const g = Array.from({ length: totalRows }, () => Array(firstDataCol + weeks).fill(''));
  const put = (rowNum, vals) => {
    const r = rowNum - 1 + leadingBlankRows;
    vals.forEach((v, i) => { g[r][firstDataCol + i] = v; });
  };
  const dates = [], opening = [], sales = [], other = [], rec = [], sup = [], out = [], close = [];
  let bal = 36014;
  for (let i = 0; i < weeks; i++) {
    const d = new Date(Date.UTC(2025, 5, 26 + i * 7));
    // The real sheet formats dates as "26-Jun-25".
    dates.push(('0' + d.getUTCDate()).slice(-2) + '-' + MONTH_ABBR[d.getUTCMonth()] + '-' + String(d.getUTCFullYear()).slice(2));
    const tin = 20000 + (i % 4) * 8000, tout = 25000 + (i % 3) * 3000;
    opening.push(bal.toFixed(2)); sales.push((tin * 0.9).toFixed(2)); other.push((tin * 0.1).toFixed(2));
    rec.push(tin.toFixed(2)); sup.push((tout * 0.4).toFixed(2)); out.push(tout.toFixed(2));
    bal = bal + tin - tout; close.push(bal.toFixed(2));
  }
  put(6, dates); put(8, opening); put(65, sales); put(74, other);
  put(76, rec); put(98, sup); put(215, out); put(217, close);
  // Row 3 carries "End of FY25" text, as in the real sheet.
  g[2 + leadingBlankRows][firstDataCol - 1] = 'End of FY25';
  // Column B labels, exactly as they appear in the spreadsheet.
  const label = (rowNum, text) => { g[rowNum - 1 + leadingBlankRows][1] = text; };
  label(6,   'Week Commencing');
  label(8,   'Opening Bank Balance');
  label(65,  'Total Sales');
  label(74,  'Total Other Income');
  label(76,  'Total Receipts');
  label(98,  'Total Supplier Payments');
  label(215, 'Total Payments Out');
  label(217, 'Closing Bank Balance');
  return g;
}

/**
 * Reproduce the reported symptom: rows shifted so offset arithmetic lands on
 * the wrong ones. Sales happens to hit a populated row; receipts and payments
 * do not — which is exactly "Total Sales $486,322 but Total In $0".
 */
function buildShiftedGrid(shift) {
  const g = buildRealisticGrid();
  const blank = () => Array(g[0].length).fill('');
  // Extra rows inserted between the week row and the totals below it.
  const head = g.slice(0, 20);
  const tail = g.slice(20);
  const inserted = [];
  for (let i = 0; i < shift; i++) inserted.push(blank());
  return head.concat(inserted, tail);
}

// --- the layout exactly as it is in the real sheet -------------------------
let snap = snapshotFromRows(buildRealisticGrid());
t('parses the real layout (dates at col 131, 217 rows)', snap.weekly.length === 20, 'weeks=' + snap.weekly.length);
t('opening balance read correctly', Math.round(snap.weekly[0].opening) === 36014, String(snap.weekly[0].opening));
t('closing balance read correctly', snap.weekly[0].closing === snap.weekly[1].opening, JSON.stringify(snap.weekly.slice(0,2)));
t('date parsed from dd-Mon-yy', snap.weekly[0].iso === '2025-06-26', snap.weekly[0].iso);
t('receipts read correctly', snap.weekly[0].total_in === 20000, String(snap.weekly[0].total_in));

// --- gviz trimming leading blank rows (the failure mode I was blind to) ----
for (const trim of [1, 2, 3, 5]) {
  const g = buildRealisticGrid();
  const trimmed = g.slice(trim);              // endpoint dropped `trim` leading rows
  const s2 = snapshotFromRows(trimmed);
  t('survives ' + trim + ' leading row(s) being trimmed', s2.weekly.length === 20, 'weeks=' + s2.weekly.length);
  if (s2.weekly.length === 20) {
    t('  ...and still reads the right opening', Math.round(s2.weekly[0].opening) === 36014, String(s2.weekly[0].opening));
  }
}

// --- extra blank rows inserted above --------------------------------------
const padded = snapshotFromRows(buildRealisticGrid({ leadingBlankRows: 4 }));
t('survives 4 blank rows inserted above', padded.weekly.length === 20, 'weeks=' + padded.weekly.length);

// --- genuinely wrong tab: must fail, not silently mis-parse ---------------
const wrongTab = Array.from({ length: 50 }, (_, r) => Array.from({ length: 20 }, (_, c) => (r * 20 + c).toString()));
const wrong = snapshotFromRows(wrongTab);
t('a numbers-only tab yields no weeks', wrong.weekly.length === 0, 'weeks=' + wrong.weekly.length);
t('and reports a diagnostic', typeof wrong.diagnostic === 'string' && wrong.diagnostic.length > 0, wrong.diagnostic);
t('bare numbers are not mistaken for dates', findWeekDateRow(wrongTab) === -1, String(findWeekDateRow(wrongTab)));

// --- empty / tiny input ----------------------------------------------------
t('empty grid yields no weeks', snapshotFromRows([]).weekly.length === 0);
t('single row yields no weeks', snapshotFromRows([['a','b']]).weekly.length === 0);

// --- THE REPORTED SYMPTOM: rows shifted below the week row ----------------
// Offsets alone put sales on a populated row and receipts on an empty one.
for (const shift of [1, 3, 7, 12]) {
  const shifted = buildShiftedGrid(shift);
  const s3 = snapshotFromRows(shifted);
  const anyIn = s3.weekly.some(w => w.total_in !== 0);
  const anyOut = s3.weekly.some(w => w.total_out !== 0);
  const anyOpen = s3.weekly.some(w => w.opening !== 0);
  t('rows shifted by ' + shift + ': receipts still found', anyIn, 'weeks=' + s3.weekly.length);
  t('rows shifted by ' + shift + ': payments still found', anyOut);
  t('rows shifted by ' + shift + ': opening still found', anyOpen);
}

// --- every row resolved by label, not guesswork ---------------------------
const mapped = snapshotFromRows(buildRealisticGrid());
const byLabel = Object.keys(mapped.rowMap).filter(k => mapped.rowMap[k].by === 'label');
t('all 7 figure rows matched by label', byLabel.length === 7, JSON.stringify(mapped.rowMap));
t('receipts resolved to row 76', mapped.rowMap.receipts.row === 76, JSON.stringify(mapped.rowMap.receipts));
t('payments out resolved to row 215', mapped.rowMap.paymentsOut.row === 215, JSON.stringify(mapped.rowMap.paymentsOut));
t('closing resolved to row 217', mapped.rowMap.closing.row === 217, JSON.stringify(mapped.rowMap.closing));

// A sheet with no labels must still work, via offsets, and say it guessed.
const unlabelled = buildRealisticGrid();
unlabelled.forEach(r => { if (typeof r[1] === 'string' && r[1] !== 'Week Commencing') r[1] = ''; });
const guessedSnap = snapshotFromRows(unlabelled);
t('unlabelled sheet still parses via offsets', guessedSnap.weekly.length === 20, 'weeks=' + guessedSnap.weekly.length);
t('and reports that rows were guessed',
  Object.keys(guessedSnap.rowMap).some(k => guessedSnap.rowMap[k].by === 'offset'), JSON.stringify(guessedSnap.rowMap));

// --- opening on the LATEST POPULATED week, not an empty current week ------
function gridWithTrailingBlanks(populatedWeeks, blankWeeks) {
  const g = buildRealisticGrid({ weeks: populatedWeeks + blankWeeks });
  // Wipe the figures for the trailing weeks, keeping their dates.
  const firstDataCol = 131;
  [8, 65, 74, 76, 98, 215, 217].forEach(rowNum => {
    for (let i = populatedWeeks; i < populatedWeeks + blankWeeks; i++) g[rowNum - 1][firstDataCol + i] = '';
  });
  return g;
}
const trailing = snapshotFromRows(gridWithTrailingBlanks(10, 10));
t('opens on the last week WITH figures, not an empty one',
  trailing.currentWeekIdx === 9, 'idx=' + trailing.currentWeekIdx);
t('that week actually has figures', weekHasData(trailing.weekly[trailing.currentWeekIdx]),
  JSON.stringify(trailing.weekly[trailing.currentWeekIdx]));

// pickCurrentWeek in isolation
const mk = (iso, io_) => ({ iso, total_in: io_, total_out: 0, opening: 0, closing: 0, sales: 0 });
t('all-empty weeks fall back to the last past week',
  pickCurrentWeek([mk('2025-01-01',0), mk('2025-01-08',0)], '2030-01-01') === 1);
t('future-only data still selects a populated week',
  pickCurrentWeek([mk('2030-01-01',500)], '2020-01-01') === 0);
t('prefers a past populated week over a future one',
  pickCurrentWeek([mk('2020-01-01',100), mk('2030-01-01',900)], '2025-01-01') === 0);

// --- URL candidates: the earlier bug --------------------------------------
const ID = '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c';
const withGid = candidateUrls({ kind: 'sheet', id: ID, gid: '457366843' });
t('a gid no longer suppresses the tab name', withGid[0].includes('sheet=Business%20Working%20Account'), withGid[0]);
t('tab name is tried FIRST', describeEndpoint(withGid[0]).includes('by name'), describeEndpoint(withGid[0]));
t('the gid is still tried, as a fallback', withGid.some(u => u.includes('gid=457366843')), JSON.stringify(withGid.map(describeEndpoint)));
t('raw-grid export is among the candidates', withGid.some(u => u.includes('/export?format=csv')), JSON.stringify(withGid.map(describeEndpoint)));
t('multiple endpoints are attempted', withGid.length >= 3, 'n=' + withGid.length);

const noGid = candidateUrls({ kind: 'sheet', id: ID, gid: null });
t('without a gid, tab name still first', noGid[0].includes('sheet=Business%20Working%20Account'), noGid[0]);

const ALLOWED = new Set(['docs.google.com', 'script.google.com', 'script.googleusercontent.com']);
t('every candidate passes the proxy allowlist',
  withGid.concat(noGid).every(u => ALLOWED.has(new URL(u).hostname)));

t('apps script yields exactly one candidate',
  candidateUrls({ kind: 'appsscript', url: 'https://script.google.com/macros/s/AK/exec' }).length === 1);

// ==========================================================================
// REGRESSION: the live spreadsheet's own wording.
//
// The client reported "$107,000 in total sales but cash in, cash out and net
// all blank". The sheet names those two rows "Total Business Receipts (Cash
// Inwards)" and "Total Business Payments (Cash Outwards)", which the original
// /^total receipts/ and /^total payments out/ patterns never matched. Both
// fell through to offsets, and because gviz trims blank rows the offsets
// landed on a supplier row and past the end of the sheet respectively.
// ==========================================================================

function buildLiveGrid(opts) {
  const g = buildRealisticGrid(opts);
  const relabel = (rowNum, text) => { g[rowNum - 1][1] = text; };
  relabel(76,  'Total Business Receipts (Cash Inwards)');
  relabel(215, 'Total Business Payments (Cash Outwards)');
  return g;
}

const live = snapshotFromRows(buildLiveGrid());
t('LIVE: "Total Business Receipts (Cash Inwards)" matches',
  live.rowMap.receipts.by === 'label' && live.rowMap.receipts.row === 76, JSON.stringify(live.rowMap.receipts));
t('LIVE: "Total Business Payments (Cash Outwards)" matches',
  live.rowMap.paymentsOut.by === 'label' && live.rowMap.paymentsOut.row === 215, JSON.stringify(live.rowMap.paymentsOut));
t('LIVE: cash in is not zero', live.weekly[0].total_in === 20000, String(live.weekly[0].total_in));
t('LIVE: cash out is not zero', live.weekly[0].total_out === 25000, String(live.weekly[0].total_out));
t('LIVE: net is not zero', live.weekly[0].total_in - live.weekly[0].total_out === -5000);
t('LIVE: no parse warnings', live.parseWarnings.length === 0, JSON.stringify(live.parseWarnings));
t('LIVE: identity holds on every week',
  live.weekly.every(w => Math.abs(w.opening + w.total_in - w.total_out - w.closing) < 1));

// The same sheet as gviz serves it — leading blank rows trimmed away.
const liveTrimmed = snapshotFromRows(buildLiveGrid().slice(5));
t('LIVE: survives gviz row-trimming', liveTrimmed.weekly.length === 20, 'weeks=' + liveTrimmed.weekly.length);
t('LIVE: cash in still correct after trimming', liveTrimmed.weekly[0].total_in === 20000, String(liveTrimmed.weekly[0].total_in));

// --- an unmatched row must never read as a silent zero --------------------
const noReceipts = buildLiveGrid();
noReceipts[75][1] = 'Something Else Entirely';
for (let i = 0; i < 20; i++) noReceipts[75][131 + i] = '';   // and the row is blank
const derived = snapshotFromRows(noReceipts);
t('missing receipts row is reported, not silently zeroed',
  derived.rowMap.receipts.by === 'derived', JSON.stringify(derived.rowMap.receipts));
t('cash in derived from sales + other income',
  derived.weekly[0].total_in === 20000, String(derived.weekly[0].total_in));
t('a derivation raises a parse warning', derived.parseWarnings.length > 0, JSON.stringify(derived.parseWarnings));

// Payments row gone: recover it from the accounting identity.
const noPayments = buildLiveGrid();
noPayments[214][1] = 'Nothing To See Here';
for (let i = 0; i < 20; i++) noPayments[214][131 + i] = '';
const viaIdentity = snapshotFromRows(noPayments);
t('cash out recovered via opening + in - closing',
  viaIdentity.weekly[0].total_out === 25000, String(viaIdentity.weekly[0].total_out));
t('and it is flagged as derived, not read',
  viaIdentity.rowMap.paymentsOut.by === 'derived', JSON.stringify(viaIdentity.rowMap.paymentsOut));

// --- a summary block above the detail must not win ------------------------
const withSummary = buildLiveGrid();
withSummary[9][1] = 'Total Sales';           // an empty summary line near the top
const summarySnap = snapshotFromRows(withSummary);
t('an empty summary row does not outrank the real detail row',
  summarySnap.rowMap.sales.row === 65, JSON.stringify(summarySnap.rowMap.sales));

// --- a sheet with nothing recognisable must say so ------------------------
const blankMoney = buildLiveGrid();
[76, 215, 217].forEach(rowNum => {
  blankMoney[rowNum - 1][1] = 'Unrecognised';
  for (let i = 0; i < 20; i++) blankMoney[rowNum - 1][131 + i] = '';
});
const noMove = snapshotFromRows(blankMoney);
t('a sheet with no cash movement warns instead of showing zeros',
  noMove.parseWarnings.some(w => /no money in or out/i.test(w)) ||
  noMove.parseWarnings.some(w => /could not be found/i.test(w)), JSON.stringify(noMove.parseWarnings));

// --- secondary account tabs ------------------------------------------------
// These tabs carry no "Week Commencing" label: the date row is found by
// sniffing, and opening/closing by their own labels.
function buildAccountTab(opts) {
  const o = Object.assign({ weeks: 20, closing: 7059, blankAfter: null }, opts || {});
  const cols = 3 + o.weeks;
  const g = Array.from({ length: 26 }, () => Array(cols).fill(''));
  g[0][1] = 'Weekly Cash Flow Forecast';
  g[3][1] = 'Opening Bank Balance';
  g[25][1] = 'Closing Bank Balance';
  for (let i = 0; i < o.weeks; i++) {
    const d = new Date(Date.UTC(2025, 5, 26 + i * 7));
    g[2][2 + i] = ('0' + d.getUTCDate()).slice(-2) + '-' + MONTH_ABBR[d.getUTCMonth()] + '-' + String(d.getUTCFullYear()).slice(2);
    if (o.blankAfter !== null && i > o.blankAfter) continue;
    g[3][2 + i] = String(o.closing - 500);
    g[25][2 + i] = String(o.closing);
  }
  return g;
}

const regTab = accountFromRows(buildAccountTab({}), '2025-07-03');
t('ACCOUNTS: a secondary tab with no week label still parses', regTab !== null, JSON.stringify(regTab));
t('ACCOUNTS: closing balance read', regTab && regTab.closing === 7059, JSON.stringify(regTab));
t('ACCOUNTS: matched week is not flagged stale', regTab && regTab.stale === false, JSON.stringify(regTab));

// The Profit Reinvestment tab: a genuine zero balance. This used to return
// null, so the card showed a dash and told the user to check a tab that
// existed and had parsed perfectly well.
const zeroTab = accountFromRows(buildAccountTab({ closing: 0 }), '2025-07-03');
t('ACCOUNTS: an all-zero tab is a $0 balance, not a missing tab', zeroTab !== null, JSON.stringify(zeroTab));
t('ACCOUNTS: and its closing reads as 0', zeroTab && zeroTab.closing === 0, JSON.stringify(zeroTab));

// The Savings tab: real figures, but none for the week on screen.
const staleTab = accountFromRows(buildAccountTab({ blankAfter: 4 }), '2025-12-25');
t('ACCOUNTS: an out-of-date tab still returns its last balance', staleTab !== null, JSON.stringify(staleTab));
t('ACCOUNTS: and is flagged stale so it is not shown as current',
  staleTab && staleTab.stale === true, JSON.stringify(staleTab));
t('ACCOUNTS: and carries the date it is actually from',
  staleTab && staleTab.asOf === '2025-07-24', JSON.stringify(staleTab));

// --- tab-name aliases -----------------------------------------------------
const profitUrls = candidateUrls({ kind: 'sheet', id: ID, gid: null }, 'Profit Reinvest. Bank Account');
t('ALIASES: the canonical tab name is tried first',
  profitUrls[0].includes(encodeURIComponent('Profit Reinvest. Bank Account')), profitUrls[0]);
t('ALIASES: a renamed tab is also attempted',
  profitUrls.some(u => u.includes(encodeURIComponent('Profit Reinvestment Bank Account'))),
  'n=' + profitUrls.length);
t('ALIASES: no gid/first-tab fallback for a named secondary tab',
  !profitUrls.some(u => /gid=|format=csv$/.test(u)), JSON.stringify(profitUrls.map(describeEndpoint)));
t('ALIASES: every aliased URL still passes the proxy allowlist',
  profitUrls.every(u => ALLOWED.has(new URL(u).hostname)));

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
