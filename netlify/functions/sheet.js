/**
 * CORS proxy for the Google Sheets data source.
 *
 * The browser cannot fetch Apps Script or docs.google.com directly (no CORS
 * headers), so the dashboard calls /.netlify/functions/sheet?url=<encoded>
 * and this function fetches it server-side.
 *
 * The `url` parameter is attacker-controllable, so it is validated against a
 * host allowlist to prevent the function being used as an open proxy / SSRF
 * pivot into Netlify's network.
 */

const ALLOWED_HOSTS = new Set([
  'script.google.com',
  'script.googleusercontent.com',
  'docs.google.com'
]);

const BASE_HEADERS = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, max-age=0',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

const reply = (statusCode, body) => ({
  statusCode,
  headers: BASE_HEADERS,
  body: JSON.stringify(body)
});

/**
 * RFC 4180 CSV → array of rows. Handles quoted fields containing commas,
 * newlines and escaped quotes, which a naive split(',') mangles.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') { quoted = true; }
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\r') { /* handled by the \n branch */ }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else { field += ch; }
  }

  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: BASE_HEADERS, body: '' };
  }
  if (event.httpMethod !== 'GET') {
    return reply(405, { error: 'Method not allowed' });
  }

  const target = event.queryStringParameters && event.queryStringParameters.url;
  if (!target) return reply(400, { error: 'Missing required "url" query parameter' });

  let parsed;
  try {
    parsed = new URL(target);
  } catch (_) {
    return reply(400, { error: 'Malformed url parameter' });
  }

  if (parsed.protocol !== 'https:') {
    return reply(400, { error: 'Only https URLs are supported' });
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return reply(403, {
      error: 'Host not allowed',
      host: parsed.hostname,
      allowed: Array.from(ALLOWED_HOSTS)
    });
  }

  // Google caches published CSV aggressively; a changing param defeats it so
  // an edit shows up on the next poll rather than several minutes later.
  parsed.searchParams.set('_cb', Date.now().toString(36));

  let upstream;
  try {
    upstream = await fetch(parsed.toString(), {
      redirect: 'follow',
      headers: { 'User-Agent': 'cashflow-dashboard/1.0', 'Accept': 'application/json, text/csv, */*' }
    });
  } catch (err) {
    return reply(502, { error: 'Upstream fetch failed', detail: String(err && err.message || err) });
  }

  if (!upstream.ok) {
    return reply(502, { error: 'Upstream returned ' + upstream.status, status: upstream.status });
  }

  const contentType = upstream.headers.get('content-type') || '';
  const text = await upstream.text();

  // Apps Script returns our snapshot contract directly; pass it through.
  if (contentType.includes('json') || text.trim().startsWith('{')) {
    try {
      const json = JSON.parse(text);
      if (json && json.error) return reply(502, { error: 'Upstream reported: ' + json.error });
      return reply(200, { kind: 'snapshot', fetchedAt: new Date().toISOString(), snapshot: json });
    } catch (_) {
      return reply(502, { error: 'Upstream returned malformed JSON' });
    }
  }

  // Otherwise treat it as CSV and hand back raw rows for the legacy parser.
  const rows = parseCsv(text);
  if (!rows.length) return reply(502, { error: 'Upstream returned no parseable rows' });

  return reply(200, { kind: 'rows', fetchedAt: new Date().toISOString(), rows });
};
