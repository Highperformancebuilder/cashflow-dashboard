// Exercise the row-detection and URL-candidate logic against layouts that
// mirror the real spreadsheet, including gviz's row-trimming behaviour.
const fs = require('fs');
const src = fs.readFileSync('/home/user/cashflow-dashboard/index.html', 'utf8');
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
  pick(/const ROW_OFFSET = \{[\s\S]*?\};/),
  grab('csvNum'), grab('csvDate'),
  grab('findWeekDateRow'), grab('snapshotFromRows'),
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
  g[5 + leadingBlankRows][1] = 'Week Commencing';
  return g;
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

// --- URL candidates: the actual bug ---------------------------------------
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

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
