// Static server + a stand-in for the Netlify function, so the dashboard can be
// exercised exactly as it will run in production.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const KNOWN_SHEET = '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c';

// A miniature Working Account grid in the real sheet's shape.
function buildGrid(weeks) {
  const grid = Array.from({ length: 217 }, () => Array(3 + weeks.length).fill(''));
  const put = (row, vals) => vals.forEach((v, i) => { grid[row - 1][3 + i] = v; });
  const label = (rowNum, text) => { grid[rowNum - 1][1] = text; };
  // Wording taken verbatim from the live spreadsheet — the two "Business"
  // rows are the ones the original patterns failed to match.
  label(6,   'Week Commencing');
  label(8,   'Opening Bank Balance');
  label(65,  'Total Sales');
  label(74,  'Total Other Income');
  label(76,  'Total Business Receipts (Cash Inwards)');
  label(98,  'Total Supplier Payments');
  label(215, 'Total Business Payments (Cash Outwards)');
  label(217, 'Closing Bank Balance');
  put(6,   weeks.map(w => w.iso));
  put(8,   weeks.map(w => w.opening));
  put(65,  weeks.map(w => w.sales));
  put(74,  weeks.map(w => w.other));
  put(76,  weeks.map(w => w.tin));
  put(98,  weeks.map(w => w.sup));
  put(215, weeks.map(w => w.tout));
  put(217, weeks.map(w => w.opening + w.tin - w.tout));
  return grid;
}

// Bumping this simulates somebody editing the spreadsheet.
let salesBump = 0;

// Tabs the fixture should pretend are absent, driven by /__hide.
const MISSING_TABS = new Set();

// A secondary account tab: same row labels, only opening and closing filled.
function buildAccountGrid(ws, balances) {
  const grid = Array.from({ length: 217 }, () => Array(3 + ws.length).fill(''));
  grid[5][1] = 'Week Commencing';
  grid[7][1] = 'Opening Bank Balance';
  grid[216][1] = 'Closing Bank Balance';
  ws.forEach((w, i) => {
    grid[5][3 + i] = w.iso;
    grid[7][3 + i] = balances.opening;
    grid[216][3 + i] = balances.closing;
  });
  return grid;
}

function weeks() {
  const out = [];
  let opening = 10000;
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2025, 6, 3 + i * 7));
    const tin = 20000 + (i % 5) * 9000 + salesBump;
    const tout = 25000 + (i % 3) * 4000;
    out.push({ iso: d.toISOString().slice(0, 10), opening, sales: tin * 0.9, other: tin * 0.1, tin, sup: tout * 0.4, tout });
    opening = opening + tin - tout;
  }
  return out;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // Stand-in for the Netlify proxy. Mirrors its host allowlist and its
  // rows/snapshot response contract.
  if (url.pathname === '/.netlify/functions/sheet') {
    const target = url.searchParams.get('url');
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Missing required "url" query parameter' }));
    }
    let host;
    try { host = new URL(target).hostname; } catch (_) { host = ''; }
    if (!['docs.google.com', 'script.google.com', 'script.googleusercontent.com'].includes(host)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Host not allowed', host }));
    }
    // A sheet id the fixture does not know about behaves like a private sheet.
    if (target.includes('/d/') && !target.includes(KNOWN_SHEET) && !target.includes('/d/e/')) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Upstream returned 404' }));
    }
    // Serve whichever tab was asked for, as the real spreadsheet would.
    const tab = decodeURIComponent((target.match(/[?&]sheet=([^&]*)/) || [])[1] || '');
    const SECONDARY = {
      'Regulation Bank Account':       { opening: 15658, closing: 7059 },
      'Business Savings Account':      { opening: 49000, closing: 50000 },
      'Profit Reinvest. Bank Account': { opening: 0,     closing: 1200 }
    };
    if (SECONDARY[tab]) {
      if (MISSING_TABS.has(tab)) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Upstream returned 400' }));
      }
      const grid = buildAccountGrid(weeks(), SECONDARY[tab]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ kind: 'rows', fetchedAt: new Date().toISOString(), rows: grid }));
    }
    const grid = buildGrid(weeks());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ kind: 'rows', fetchedAt: new Date().toISOString(), rows: grid }));
  }

  // Test hook: pretend a tab is missing.
  if (url.pathname === '/__hide') {
    const t = url.searchParams.get('tab');
    if (t === '') MISSING_TABS.clear(); else MISSING_TABS.add(t);
    res.writeHead(204);
    return res.end();
  }

  // Test hook: pretend somebody edited the spreadsheet.
  if (url.pathname === '/__mutate') {
    salesBump = parseFloat(url.searchParams.get('v')) || 0;
    res.writeHead(204);
    return res.end();
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(ROOT, file);
  if (!full.startsWith(ROOT) || !fs.existsSync(full)) { res.writeHead(404); return res.end('nope'); }
  res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html' : 'text/plain' });
  res.end(fs.readFileSync(full));
}).listen(8099, () => console.log('listening on 8099'));
