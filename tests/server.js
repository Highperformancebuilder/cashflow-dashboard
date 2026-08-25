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
    const grid = buildGrid(weeks());
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ kind: 'rows', fetchedAt: new Date().toISOString(), rows: grid }));
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
