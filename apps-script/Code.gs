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
 *     SHEET_ID              the spreadsheet id
 *     SUPABASE_URL          https://<project>.supabase.co
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
  var d = new Date(String(v));
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
var ROW_LABELS = [
  { key: 'weekDates',   re: /^week\s*commencing/i },
  { key: 'opening',     re: /^opening\s*bank\s*balance/i },
  { key: 'sales',       re: /^total\s*sales/i },
  { key: 'otherIncome', re: /^total\s*other\s*income/i },
  { key: 'receipts',    re: /^total\s*receipts/i },
  { key: 'supplier',    re: /^total\s*supplier\s*payments/i },
  { key: 'paymentsOut', re: /^total\s*payments\s*out/i },
  { key: 'closing',     re: /^closing\s*bank\s*balance/i }
];

/** Map each known label to its 0-based row index. First match wins. */
function findLabelledRows_(grid) {
  var found = {};
  for (var r = 0; r < grid.length; r++) {
    var row = grid[r] || [];
    var scan = Math.min(row.length, 5);
    for (var c = 0; c < scan; c++) {
      var cell = row[c];
      if (typeof cell !== 'string') continue;
      var text = cell.trim();
      if (!text) continue;
      for (var i = 0; i < ROW_LABELS.length; i++) {
        var spec = ROW_LABELS[i];
        if (found[spec.key] === undefined && spec.re.test(text)) found[spec.key] = r;
      }
    }
  }
  return found;
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
function parseWeekly_(grid) {
  var labelled = findLabelledRows_(grid);
  var base = (labelled.weekDates !== undefined) ? labelled.weekDates : findWeekDateRow_(grid);
  if (base < 0) return [];

  // By label where the sheet names the row, else by offset from the week row.
  var at = function (key, offset) {
    var idx = (labelled[key] !== undefined) ? labelled[key] : base + offset;
    return grid[idx] || [];
  };
  var dates    = grid[base] || [];
  var opening  = at('opening',     ROW_OFFSET.opening);
  var sales    = at('sales',       ROW_OFFSET.sales);
  var otherIn  = at('otherIncome', ROW_OFFSET.otherIncome);
  var receipts = at('receipts',    ROW_OFFSET.receipts);
  var supplier = at('supplier',    ROW_OFFSET.supplier);
  var payments = at('paymentsOut', ROW_OFFSET.paymentsOut);
  var closing  = at('closing',     ROW_OFFSET.closing);

  var weeks = [];
  for (var col = 0; col < dates.length; col++) {
    var d = date_(dates[col]);
    if (!d || d.getUTCFullYear() < 2020 || d.getUTCFullYear() > 2100) continue;

    var open = num_(opening[col]);
    var totalIn = num_(receipts[col]);
    var totalOut = num_(payments[col]);

    // Prefer the sheet's own closing figure; fall back to the identity so a
    // blank row still produces a continuous series.
    var close = closing[col] === '' || closing[col] === null || closing[col] === undefined
      ? open + totalIn - totalOut
      : num_(closing[col]);

    weeks.push({
      idx: weeks.length,
      iso: isoDate_(d),
      label: weekLabel_(d),
      opening: open,
      sales: num_(sales[col]),
      other_income: num_(otherIn[col]),
      total_in: totalIn,
      supplier: num_(supplier[col]),
      total_out: totalOut,
      closing: close
    });
  }
  return weeks;
}

/**
 * Pull opening/closing for a secondary account. These sheets share the row
 * layout but not the column layout, so the current week is located by matching
 * the week-date row when present, else by taking the last populated column.
 */
function parseAccount_(grid, currentIso) {
  var labelled = findLabelledRows_(grid);
  var base = (labelled.weekDates !== undefined) ? labelled.weekDates : findWeekDateRow_(grid);
  var at = function (key, offset, fallbackRow) {
    if (labelled[key] !== undefined) return grid[labelled[key]] || [];
    if (base >= 0) return grid[base + offset] || [];
    return rowValues_(grid, fallbackRow);
  };
  var dates   = base >= 0 ? (grid[base] || []) : rowValues_(grid, ROW.weekDates);
  var opening = at('opening', ROW_OFFSET.opening, ROW.opening);
  var closing = at('closing', ROW_OFFSET.closing, ROW.closing);

  var target = -1;
  for (var col = 0; col < dates.length; col++) {
    var d = date_(dates[col]);
    if (d && isoDate_(d) === currentIso) { target = col; break; }
  }

  if (target === -1) {
    // No matching date row — fall back to the rightmost column carrying a balance.
    for (var c = closing.length - 1; c >= 0; c--) {
      if (closing[c] !== '' && closing[c] !== null && closing[c] !== undefined) { target = c; break; }
    }
  }
  if (target === -1) return null;

  return {
    opening: num_(opening[target]),
    closing: num_(closing[target])
  };
}

/** Weekly contribution for a savings-style account, used for the 12m projection. */
function weeklyContribution_(grid) {
  var closing = rowValues_(grid, ROW.closing);
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
function buildSnapshot() {
  var ss = SpreadsheetApp.openById(sheetId_());
  var grids = {};

  ACCOUNTS.forEach(function (acct) {
    var sh = ss.getSheetByName(acct.sheet);
    grids[acct.key] = sh ? sh.getDataRange().getValues() : null;
  });

  if (!grids.working) {
    throw new Error('Sheet "' + ACCOUNTS[0].sheet + '" not found in spreadsheet ' + sheetId_());
  }

  var weekly = parseWeekly_(grids.working);
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

    if (!parsed) { accounts[acct.key] = null; return; }

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
    accounts: accounts
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
  console.log('weeks: %s | current: %s | accounts: %s',
    s.weekly.length, s.currentWeekIso, JSON.stringify(s.accounts));
  return s;
}
