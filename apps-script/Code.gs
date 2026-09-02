/**
 * Greg Jones Cashflow — Google Sheets → Supabase realtime bridge.
 *
 * Responsibilities:
 *   1. Parse the four account sheets into one compact snapshot (the canonical
 *      parser — the dashboard does no row/column mapping of its own).
 *   2. Serve that snapshot over HTTPS via doGet, for initial load and polling.
 *   3. Push it to Supabase on every sheet change, so Realtime can broadcast it.
 *
 * SETUP — see README.md. In short:
 *   Extensions > Apps Script, paste this file, then set Script Properties:
 *     SHEET_ID              1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c
 *     SUPABASE_URL          https://abhmonhsiluraykelrpp.supabase.co
 *     SUPABASE_SERVICE_KEY  service_role key (server-side only, never in the browser)
 *   Run installTrigger() once, then Deploy > New deployment > Web app
 *   (Execute as: Me — Who has access: Anyone).
 */

var SNAPSHOT_VERSION = 1;

// Row numbers are 1-based and come straight from the spreadsheet layout.
// These must not move without updating the sheet — see README.
var ROW = {
  weekDates: 6,
  opening: 8,
  totalSales: 65,
  totalOtherIncome: 74,
  totalReceipts: 76,
  totalSupplierPayments: 98,
  totalPaymentsOut: 215,
  closing: 217
};

var ACCOUNTS = [
  { key: 'working',    sheet: 'Business Working Account',      label: 'Working Account' },
  { key: 'regulation', sheet: 'Regulation Bank Account',       label: 'Regulation Account' },
  { key: 'savings',    sheet: 'Business Savings Account',      label: 'Savings Account' },
  { key: 'profit',     sheet: 'Profit Reinvest. Bank Account', label: 'Profit Reinvestment' }
];

var MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function prop_(name) {
  return PropertiesService.getScriptProperties().getProperty(name);
}

function sheetId_() {
  var id = prop_('SHEET_ID');
  if (!id) throw new Error('Script Property SHEET_ID is not set.');
  return id;
}

/** Coerce a cell to a number, tolerating "$1,234.00", "(500)" and blanks. */
function num_(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = String(v).trim();
  if (!s) return 0;
  var negative = /^\(.*\)$/.test(s);
  s = s.replace(/[()$,\s]/g, '');
  var n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return negative ? -n : n;
}

/** Coerce a cell to a Date, or null. Handles Date objects and Excel serials. */
function date_(v) {
  if (!v) return null;
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return isNaN(v.getTime()) ? null : v;
  }
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Math.round((v - 25569) * 86400000));
  }

  var s = String(v).trim();
  if (!s) return null;

  // dd-Mon-yy / dd Mon yy, the format the sheet displays. getValues() normally
  // hands back real Date objects, but a text-formatted column arrives as a
  // string and new Date() reads "20-Aug-26" inconsistently across engines.
  var m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[a-z]*[-\s](\d{2,4})$/);
  if (m) {
    var mi = MONTH_ABBR.indexOf(m[2].charAt(0).toUpperCase() + m[2].slice(1, 3).toLowerCase());
    if (mi >= 0) {
      var yr = m[3].length === 2 ? 2000 + parseInt(m[3], 10) : parseInt(m[3], 10);
      return new Date(Date.UTC(yr, mi, parseInt(m[1], 10)));
    }
  }

  var d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}

function isoDate_(d) {
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function weekLabel_(d) {
  var dd = ('0' + d.getUTCDate()).slice(-2);
  return dd + ' ' + MONTH_ABBR[d.getUTCMonth()] + ' ' + String(d.getUTCFullYear()).slice(2);
}

function rowValues_(grid, rowNumber) {
  var r = grid[rowNumber - 1];
  return r ? r : [];
}

// Every row is expressed as an offset from the week-date row, so inserting a
// row above row 6 shifts the layout without breaking parsing.
var ROW_OFFSET = {
  opening:     ROW.opening               - ROW.weekDates,
  sales:       ROW.totalSales            - ROW.weekDates,
  otherIncome: ROW.totalOtherIncome      - ROW.weekDates,
  receipts:    ROW.totalReceipts         - ROW.weekDates,
  supplier:    ROW.totalSupplierPayments - ROW.weekDates,
  paymentsOut: ROW.totalPaymentsOut      - ROW.weekDates,
  closing:     ROW.closing               - ROW.weekDates
};

// The sheet labels every row we need in its left-hand columns. Matching those
// labels survives inserted, deleted or reordered rows; offsets do not.
//
// Labels are compared normalised — lowercased, punctuation collapsed to single
// spaces — so "Total Receipts ($)" and "TOTAL  RECEIPTS:" both reduce to
// "total receipts".
function normLabel_(v) {
  return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Accepted wordings per figure, most specific first. The live sheet names its
// cash-movement rows "Total Business Receipts (Cash Inwards)" and "Total
// Business Payments (Cash Outwards)"; a single narrow pattern per row missed
// both and the dashboard reported no money moving in or out.
var ROW_LABELS = {
  weekDates: [/^week commencing/, /^week beginning/, /^week starting/, /^w c\b/, /^week$/],
  opening: [/^opening bank balance/, /^opening balance/, /^opening bal/,
            /^balance brought forward/, /^balance b f$/, /^bank balance opening/],
  sales: [/^total sales/, /^total revenue/, /^total income$/, /^sales total/],
  otherIncome: [/^total other income/, /^other income total/, /^total other receipts/],
  receipts: [/^total business receipts/, /^total receipts/, /^total cash receipts/,
             /^total cash in/, /^total money in/, /^total in$/, /^receipts total/],
  supplier: [/^total supplier payments/, /^supplier payments total/, /^total suppliers?/],
  paymentsOut: [/^total business payments/, /^total payments out/, /^total payments$/,
                /^total cash out/, /^total money out/, /^total out$/,
                /^total outgoings/, /^total expenses/, /^total expenditure/],
  closing: [/^closing bank balance/, /^closing balance/, /^closing bal/,
            /^balance carried forward/, /^balance c f$/, /^bank balance closing/]
};

var ROW_KEYS = Object.keys(ROW_LABELS);
var LABEL_SCAN_COLS = 12;

/** Best pattern rank for this row against `key`. 0 means no match. */
function rowLabelRank_(row, key) {
  var pats = ROW_LABELS[key];
  var scan = Math.min(row.length, LABEL_SCAN_COLS);
  var best = 0;
  for (var c = 0; c < scan; c++) {
    var text = normLabel_(row[c]);
    if (!text) continue;
    for (var p = 0; p < pats.length; p++) {
      var rank = pats.length - p;
      if (rank > best && pats[p].test(text)) best = rank;
    }
  }
  return best;
}

/** How many of the week columns of this row carry a number. 0 = empty row. */
function rowDataCount_(row, weekCols) {
  if (!row) return 0;
  var n = 0;
  for (var i = 0; i < weekCols.length; i++) if (num_(row[weekCols[i]]) !== 0) n++;
  return n;
}

/**
 * Work out which grid row supplies each figure.
 *
 * Rows that carry figures beat empty ones, then the more specific wording
 * wins, then the row closest to the documented layout. A row located only by
 * offset that carries no figures is reported missing rather than read as a
 * column of zeros.
 */
function resolveRows_(grid) {
  var dateRow = -1, bestRank = 0, r;
  for (r = 0; r < grid.length; r++) {
    var rank = rowLabelRank_(grid[r] || [], 'weekDates');
    if (rank > bestRank) { bestRank = rank; dateRow = r; }
  }
  if (dateRow < 0) dateRow = findWeekDateRow_(grid);
  if (dateRow < 0) return { dateRow: -1, weekCols: [], map: {}, warnings: [] };

  var dates = grid[dateRow] || [];
  var weekCols = [];
  for (var c = 0; c < dates.length; c++) {
    var d = date_(dates[c]);
    if (d && d.getUTCFullYear() >= 2015 && d.getUTCFullYear() <= 2100) weekCols.push(c);
  }

  var better = function (a, b) {
    if (!b) return true;
    if ((a.data > 0) !== (b.data > 0)) return a.data > 0;
    if (a.rank !== b.rank) return a.rank > b.rank;
    return a.dist < b.dist;
  };

  var map = {}, warnings = [];
  ROW_KEYS.forEach(function (key) {
    if (key === 'weekDates') return;
    var expected = dateRow + ROW_OFFSET[key];
    var best = null;
    for (var r2 = 0; r2 < grid.length; r2++) {
      var rk = rowLabelRank_(grid[r2] || [], key);
      if (!rk) continue;
      var cand = { row: r2, rank: rk, data: rowDataCount_(grid[r2], weekCols),
                   dist: Math.abs(r2 - expected) };
      if (better(cand, best)) best = cand;
    }
    if (best) {
      map[key] = { row: best.row + 1, index: best.row, by: 'label', cells: best.data };
      if (!best.data) warnings.push(key + ' matched row ' + (best.row + 1) + ', but that row is empty');
      return;
    }
    var guessData = rowDataCount_(grid[expected], weekCols);
    if (guessData > 0) {
      map[key] = { row: expected + 1, index: expected, by: 'offset', cells: guessData };
      warnings.push(key + ' could not be matched by name; read from row ' + (expected + 1) + ' by position');
    } else {
      map[key] = { row: null, index: -1, by: 'missing', cells: 0 };
      warnings.push(key + ' could not be found in this sheet');
    }
  });

  return { dateRow: dateRow, weekCols: weekCols, map: map, warnings: warnings };
}

/**
 * Locate the week-date row. Returns a 0-based index, or -1.
 * Bare numbers are skipped so a row of figures cannot be read as dates.
 */
function findWeekDateRow_(grid) {
  var bestRow = -1, bestCount = 0;
  var limit = Math.min(grid.length, 40);
  for (var r = 0; r < limit; r++) {
    var row = grid[r] || [];
    var count = 0;
    for (var c = 0; c < row.length; c++) {
      var raw = row[c];
      if (raw === '' || raw === null || raw === undefined) continue;
      if (typeof raw === 'number') continue;
      var d = date_(raw);
      if (d && d.getUTCFullYear() >= 2015 && d.getUTCFullYear() <= 2100) count++;
    }
    if (count > bestCount) { bestCount = count; bestRow = r; }
  }
  return bestCount >= 5 ? bestRow : -1;
}

/**
 * Parse the Working Account grid into the weekly series.
 * Columns are discovered from the week-date row rather than hardcoded, so the
 * series keeps working when weeks are appended to the sheet.
 */
function parseWeekly_(grid, out) {
  var res = resolveRows_(grid);
  if (res.dateRow < 0) return [];

  var m = res.map;
  if (out) { out.rowMap = m; out.warnings = res.warnings.slice(); }

  // A row never located, or holding no figures at all, is treated as absent so
  // the reconciliation below can derive it. A row that IS present but blank in
  // one week stays a genuine zero for that week.
  var at = function (key) {
    var info = m[key];
    if (!info || info.index < 0 || info.cells === 0) return null;
    return grid[info.index] || null;
  };

  var dates       = grid[res.dateRow] || [];
  var opening     = at('opening');
  var salesRow    = at('sales');
  var otherRow    = at('otherIncome');
  var receiptsRow = at('receipts');
  var supplierRow = at('supplier');
  var paymentsRow = at('paymentsOut');
  var closingRow  = at('closing');

  var derivedIn = 0, derivedOut = 0, derivedClose = 0;
  var weeks = [];

  for (var col = 0; col < dates.length; col++) {
    var d = date_(dates[col]);
    if (!d || d.getUTCFullYear() < 2020 || d.getUTCFullYear() > 2100) continue;

    var cell = function (row) { return row ? num_(row[col]) : null; };

    var open  = cell(opening) || 0;
    var sales = cell(salesRow) || 0;
    var other = cell(otherRow) || 0;
    var supp  = cell(supplierRow) || 0;

    var totalIn  = cell(receiptsRow);
    var totalOut = cell(paymentsRow);
    var close    = cell(closingRow);

    // Reconcile whatever is missing from what is present, via the identity
    //   closing = opening + in - out
    if (totalIn === null && (salesRow || otherRow)) { totalIn = sales + other; derivedIn++; }
    if (totalOut === null && close !== null && totalIn !== null) { totalOut = open + totalIn - close; derivedOut++; }
    if (totalIn === null && close !== null && totalOut !== null) { totalIn = close - open + totalOut; derivedIn++; }
    if (close === null && totalIn !== null && totalOut !== null) { close = open + totalIn - totalOut; derivedClose++; }

    if (totalIn === null) totalIn = 0;
    if (totalOut === null) totalOut = 0;
    if (close === null) close = open + totalIn - totalOut;

    weeks.push({
      idx: weeks.length,
      iso: isoDate_(d),
      label: weekLabel_(d),
      opening: open,
      sales: sales,
      other_income: other,
      total_in: totalIn,
      supplier: supp,
      total_out: totalOut,
      closing: close
    });
  }

  if (out) {
    if (derivedIn)    m.receipts    = { row: m.receipts.row,    by: 'derived', from: 'Total Sales + Total Other Income' };
    if (derivedOut)   m.paymentsOut = { row: m.paymentsOut.row, by: 'derived', from: 'opening + cash in - closing' };
    if (derivedClose) m.closing     = { row: m.closing.row,     by: 'derived', from: 'opening + cash in - cash out' };
    var noMovement = weeks.length > 0 && weeks.every(function (w) {
      return w.total_in === 0 && w.total_out === 0;
    });
    if (noMovement) out.warnings.push('Read ' + weeks.length + ' weeks but found no money in or out on any of them');
  }

  return weeks;
}

/**
 * Pull opening/closing for a secondary account. These sheets share the row
 * layout but not the column layout, so the current week is located by matching
 * the week-date row when present, else by taking the last populated column.
 */
function parseAccount_(grid, currentIso) {
  var res = resolveRows_(grid);
  var base = res.dateRow;
  var openInfo = res.map.opening, closeInfo = res.map.closing;

  var opening = (openInfo && openInfo.index >= 0) ? (grid[openInfo.index] || []) : [];
  var closing = (closeInfo && closeInfo.index >= 0) ? (grid[closeInfo.index] || []) : [];
  if (!opening.length && !closing.length) return null;

  var dates = base >= 0 ? (grid[base] || []) : [];
  var target = -1, asOf = null, stale = false;

  for (var col = 0; col < dates.length; col++) {
    var d = date_(dates[col]);
    if (d && isoDate_(d) === currentIso) { target = col; asOf = currentIso; break; }
  }

  if (target === -1) {
    // No column for the week on screen — take the rightmost column that carries
    // a balance. A populated zero is a real $0 balance, not a parse failure:
    // the Profit Reinvestment tab is legitimately empty and used to be reported
    // as a missing tab, sending people looking for a tab that was there.
    for (var c = closing.length - 1; c >= 0; c--) {
      if (closing[c] !== '' && closing[c] !== null && closing[c] !== undefined) { target = c; break; }
    }
    if (target >= 0 && base >= 0) {
      var dd = date_(dates[target]);
      if (dd) { asOf = isoDate_(dd); stale = asOf !== currentIso; }
    }
  }
  if (target === -1) return null;

  // The whole series, keyed by week, so the dashboard's 4 Accounts tab can
  // follow whichever week the Overview navigator is on.
  var weeks = {};
  for (var w = 0; w < dates.length; w++) {
    var wd = date_(dates[w]);
    if (!wd || wd.getUTCFullYear() < 2020 || wd.getUTCFullYear() > 2100) continue;
    var oCell = opening[w], cCell = closing[w];
    var blank = function (v) { return v === '' || v === null || v === undefined; };
    if (blank(oCell) && blank(cCell)) continue;
    weeks[isoDate_(wd)] = { opening: num_(oCell), closing: num_(cCell) };
  }

  return {
    opening: num_(opening[target]),
    closing: num_(closing[target]),
    asOf: asOf,
    stale: stale,
    weeks: weeks
  };
}

/** Weekly contribution for a savings-style account, used for the 12m projection. */
function weeklyContribution_(grid) {
  // Was reading row 217 absolutely, which broke the moment a row was inserted.
  var info = resolveRows_(grid).map.closing;
  var closing = (info && info.index >= 0) ? (grid[info.index] || []) : rowValues_(grid, ROW.closing);
  var vals = [];
  for (var c = 0; c < closing.length; c++) {
    if (closing[c] === '' || closing[c] === null || closing[c] === undefined) continue;
    vals.push(num_(closing[c]));
  }
  if (vals.length < 2) return 0;
  var deltas = [];
  for (var i = 1; i < vals.length; i++) deltas.push(vals[i] - vals[i - 1]);
  deltas.sort(function (a, b) { return a - b; });
  return deltas[Math.floor(deltas.length / 2)]; // median, so one-off transfers do not skew it
}

/** Build the full snapshot the dashboard consumes. */
/**
 * Match every tab in the spreadsheet to an account, by normalised name so a
 * rename or a stray space does not silently drop a tab. Tabs the dashboard does
 * not consume are returned so the Connect panel can list them — "make sure all
 * the tabs are populating" is unanswerable if we never say what we found.
 */
function classifySheets_(ss) {
  var matched = {}, other = [];
  ss.getSheets().forEach(function (sh) {
    var name = sh.getName();
    var norm = normLabel_(name);
    var hit = null;
    ACCOUNTS.forEach(function (a) { if (normLabel_(a.sheet) === norm) hit = a.key; });
    if (hit && !matched[hit]) matched[hit] = name; else other.push(name);
  });
  return { matched: matched, other: other };
}

function buildSnapshot() {
  var ss = SpreadsheetApp.openById(sheetId_());
  var found = classifySheets_(ss);
  var grids = {};
  var tabStatus = {};

  ACCOUNTS.forEach(function (acct) {
    var name = found.matched[acct.key] || acct.sheet;
    var sh = ss.getSheetByName(name);
    grids[acct.key] = sh ? sh.getDataRange().getValues() : null;
    tabStatus[acct.sheet] = {
      key: acct.key,
      ok: !!sh,
      resolvedName: sh ? name : null,
      error: sh ? null : 'tab not found in this spreadsheet'
    };
  });

  if (!grids.working) {
    throw new Error('Sheet "' + ACCOUNTS[0].sheet + '" not found in spreadsheet ' + sheetId_() +
                    '. Tabs present: ' + found.other.join(', '));
  }

  var diag = {};
  var weekly = parseWeekly_(grids.working, diag);
  if (!weekly.length) {
    throw new Error('No week dates found in the first 40 rows of the "' + ACCOUNTS[0].sheet +
                    '" sheet. Expected them on row ' + ROW.weekDates + '.');
  }

  // Open on the most recent week that actually carries figures. Using "the
  // week containing today" shows zeros whenever the sheet is not filled in
  // that far ahead, which is the usual state.
  var todayIso = isoDate_(new Date());
  var hasData = function (w) {
    return w && (w.total_in !== 0 || w.total_out !== 0 || w.opening !== 0 || w.closing !== 0 || w.sales !== 0);
  };
  var lastPast = 0, lastPopulatedPast = -1, lastPopulated = -1;
  for (var i = 0; i < weekly.length; i++) {
    var past = weekly[i].iso <= todayIso;
    if (past) lastPast = i;
    if (hasData(weekly[i])) {
      lastPopulated = i;
      if (past) lastPopulatedPast = i;
    }
  }
  var currentIdx = lastPopulatedPast >= 0 ? lastPopulatedPast
                 : lastPopulated    >= 0 ? lastPopulated
                 : lastPast;
  var currentIso = weekly[currentIdx].iso;

  var accounts = {};
  ACCOUNTS.forEach(function (acct) {
    var grid = grids[acct.key];
    if (!grid) { accounts[acct.key] = null; return; }

    var parsed = acct.key === 'working'
      ? { opening: weekly[currentIdx].opening, closing: weekly[currentIdx].closing }
      : parseAccount_(grid, currentIso);

    if (!parsed) {
      accounts[acct.key] = null;
      tabStatus[acct.sheet].ok = false;
      tabStatus[acct.sheet].error = 'no opening/closing balance found in this tab';
      return;
    }

    parsed.label = acct.label;
    if (acct.key === 'savings' || acct.key === 'profit') {
      parsed.projected12m = parsed.closing + weeklyContribution_(grid) * 52;
    }
    accounts[acct.key] = parsed;
  });

  return {
    version: SNAPSHOT_VERSION,
    generatedAt: new Date().toISOString(),
    sheetId: sheetId_(),
    currentWeekIso: currentIso,
    currentWeekIdx: currentIdx,
    weekly: weekly,
    accounts: accounts,
    tabStatus: tabStatus,
    otherTabs: found.other,
    rowMap: diag.rowMap || null,
    parseWarnings: diag.warnings || []
  };
}

/** HTTPS endpoint: initial load and polling fallback. */
function doGet(e) {
  var body;
  try {
    body = buildSnapshot();
  } catch (err) {
    body = { error: String(err && err.message ? err.message : err) };
  }
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Write the snapshot to Supabase so Realtime broadcasts it to open dashboards. */
function pushToSupabase() {
  var url = prop_('SUPABASE_URL');
  var key = prop_('SUPABASE_SERVICE_KEY');
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY script properties are not set.');

  var snapshot = buildSnapshot();
  var res = UrlFetchApp.fetch(url.replace(/\/+$/, '') + '/rest/v1/sheet_snapshots?on_conflict=sheet_id', {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify({
      sheet_id: snapshot.sheetId,
      payload: snapshot,
      updated_at: snapshot.generatedAt
    }),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  if (code >= 300) {
    throw new Error('Supabase push failed (' + code + '): ' + res.getContentText());
  }
  return code;
}

/**
 * onChange handler. Debounced to one push per DEBOUNCE_MS so a burst of edits
 * collapses into a single write rather than hammering Supabase.
 */
var DEBOUNCE_MS = 4000;

function onSheetChange(e) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(500)) return; // another push is already in flight

  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('push_pending')) return;
    cache.put('push_pending', '1', 30);

    Utilities.sleep(DEBOUNCE_MS); // let a burst of edits settle
    cache.remove('push_pending');
    pushToSupabase();
  } catch (err) {
    console.error('onSheetChange failed: ' + err);
  } finally {
    lock.releaseLock();
  }
}

/** Run once from the Apps Script editor to wire up the change trigger. */
function installTrigger() {
  var existing = ScriptApp.getProjectTriggers();
  existing.forEach(function (t) {
    if (t.getHandlerFunction() === 'onSheetChange') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onSheetChange')
    .forSpreadsheet(sheetId_())
    .onChange()
    .create();
  return 'Trigger installed for spreadsheet ' + sheetId_();
}

/** Convenience: verify parsing and the Supabase write end to end. */
function testSnapshot() {
  var s = buildSnapshot();
  console.log('weeks: %s | current: %s', s.weekly.length, s.currentWeekIso);
  console.log('accounts: %s', JSON.stringify(s.accounts));
  console.log('rows read: %s', JSON.stringify(s.rowMap));
  console.log('tabs read: %s', JSON.stringify(s.tabStatus));
  if (s.otherTabs && s.otherTabs.length) {
    console.log('OTHER TABS in this spreadsheet, not read by the dashboard: %s', s.otherTabs.join(', '));
  }
  if (s.parseWarnings && s.parseWarnings.length) {
    console.warn('PARSE WARNINGS:\n · %s', s.parseWarnings.join('\n · '));
  } else {
    console.log('every figure matched a row by name');
  }
  return s;
}
