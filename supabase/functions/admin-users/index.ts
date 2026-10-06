/**
 * admin-users — the server half of Greg's Import Users tab, as a Supabase
 * Edge Function.
 *
 * Creating logins needs the project's secret (service_role) key, which
 * bypasses every row-level-security rule and must never reach a browser.
 * Supabase hands this function that key automatically, so it is never copied
 * into the website, the repo, or any other service. The function acts only for
 * a caller who is signed in AND marked is_admin in public.clients (Greg).
 *
 * POST https://<project>.supabase.co/functions/v1/admin-users
 *   Authorization: Bearer <the signed-in user's access token>
 *   { "action": "list" }
 *   { "action": "import", "mode": "file" | "password" | "invite", "users": [ {...} ] }
 *       file      each row's own password (from Greg's Excel sheet)
 *       password  a strong random password per person, returned once
 *       invite    Supabase emails a link; they choose their own (needs SMTP)
 *   { "action": "remove", "email": "someone@example.com" }
 *
 * Optional function secrets (Edge Functions → Secrets):
 *   SITE_URL          where invite emails send people back to
 *   DEFAULT_SHEET_ID  optional: a sheet to give imported users who have no sheet
 *                     link. Leave it UNSET (the default): people then start
 *                     with no sheet and connect their own.
 *
 * Deploy with "Verify JWT with legacy secret" OFF: the function verifies the
 * caller itself, and the gateway check rejects tokens from the new JWT signing
 * keys.
 *
 * Types are erased before running, so the same file runs in Deno on Supabase
 * and under Node in tests/admin-fn-test.js.
 */

// Supabase runs this in Deno. The editor's TypeScript service does not know
// that global, so declare the small part used here.
declare const Deno: {
  serve: (handler: (req: Request) => Response | Promise<Response>) => unknown;
  env: { get: (name: string) => string | undefined };
} | undefined;

const MAX_USERS_PER_IMPORT = 500;
// Supabase Auth rejects passwords under 6 characters; bcrypt ignores past 72.
const MIN_PASSWORD = 6;
const MAX_PASSWORD = 72;
const EMAIL_RE = /^[^\s@,;<>"]+@[^\s@,;<>"]+\.[A-Za-z]{2,}$/;

// ---- types ------------------------------------------------------------------

type Json = Record<string, any>;
type Fetch = (input: string, init?: RequestInit) => Promise<Response>;
type Mode = 'file' | 'password' | 'invite';

export interface Env {
  url: string;
  key: string;
  siteUrl?: string;
  defaultSheet?: string;
}

interface CleanRow {
  email: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  full_name: string | null;
  sheet_id: string | null;
  password: string | null;
  user_id?: string;
}

interface Login {
  status?: 'invited' | 'created' | 'existing';
  userId?: string;
  password?: string;
  error?: string;
}

interface ImportResult {
  line: number;
  email: string;
  status: string | undefined;
  error?: string;
  sheet?: string | null;
  password?: string;
}

// The browser calls this from the dashboard's own domain, so it is a
// cross-origin request. Access is decided by the bearer token, not the origin.
const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info'
};

function reply(status: number, body: Json): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: Object.assign({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, CORS)
  });
}

function serviceHeaders(env: Env, extra?: Record<string, string>): Record<string, string> {
  return Object.assign({
    apikey: env.key,
    Authorization: 'Bearer ' + env.key,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function readJson(res: Response): Promise<any> {
  const text = await res.text();
  try { return text ? JSON.parse(text) : null; } catch (_) { return { raw: text }; }
}

const messageOf = (e: unknown): string => String((e && (e as Error).message) || e);

/** Who is calling? Supabase Auth verifies their access token. */
async function callerEmail(env: Env, f: Fetch, token: string): Promise<string | null> {
  const res = await f(env.url + '/auth/v1/user', {
    headers: { apikey: env.key, Authorization: 'Bearer ' + token }
  });
  if (!res.ok) return null;
  const user = await readJson(res);
  return user && user.email ? String(user.email).toLowerCase() : null;
}

/** The caller's own clients row if they are an admin, else null. */
async function adminRow(env: Env, f: Fetch, email: string): Promise<Json | null> {
  const res = await f(
    env.url + '/rest/v1/clients?select=is_admin,sheet_id&email=eq.' + encodeURIComponent(email),
    { headers: serviceHeaders(env) }
  );
  if (!res.ok) return null;
  const rows = await readJson(res);
  return (Array.isArray(rows) && rows.find((r: Json) => r && r.is_admin === true)) || null;
}

/** A sheet link, a bare id, or blank. Returns the id, null, or undefined if unreadable. */
export function sheetIdFrom(value: unknown): string | null | undefined {
  const s = String(value || '').trim();
  if (!s) return null;
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{20,}$/.test(s)) return s;
  return undefined;
}

function tempPassword(): string {
  // 18 URL-safe characters from 14 random bytes ≈ 108 bits.
  const bytes = new Uint8Array(14);
  crypto.getRandomValues(bytes);
  const b64 = btoa(String.fromCharCode.apply(null, Array.from(bytes)));
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 18);
}

/** Normalise and validate one import row. Returns { row } or { error }. */
export function cleanRow(
  input: Json | null | undefined,
  defaultSheet: string | undefined,
  mode: string
): { row?: CleanRow; error?: string } {
  const r: Json = input || {};
  const email = String(r.email || '').trim().toLowerCase();
  if (!email) return { error: 'missing email' };
  if (!EMAIL_RE.test(email)) return { error: 'not a valid email address' };

  const first = String(r.first_name || '').trim();
  const last = String(r.last_name || '').trim();
  const company = String(r.company_name || '').trim();

  let password: string | null = null;
  if (mode === 'file') {
    password = String(r.password == null ? '' : r.password);
    if (!password) return { error: 'no password in the file' };
    if (password.length < MIN_PASSWORD) return { error: 'password must be at least ' + MIN_PASSWORD + ' characters (Supabase rule)' };
    if (password.length > MAX_PASSWORD) return { error: 'password is longer than ' + MAX_PASSWORD + ' characters' };
  }

  let sheet = sheetIdFrom(r.sheet);
  if (sheet === undefined) return { error: 'sheet link is not a Google Sheets link or id' };
  if (!sheet && defaultSheet) sheet = defaultSheet;

  return {
    row: {
      email,
      first_name: first || null,
      last_name: last || null,
      company_name: company || null,
      full_name: [first, last].filter(Boolean).join(' ') || null,
      sheet_id: sheet || null,
      password
    }
  };
}

const alreadyExists = (status: number, body: unknown): boolean =>
  status === 422 || /already (been )?registered|email_exists|user_already_exists/i.test(JSON.stringify(body || ''));

const errText = (body: Json | null, status: number): string =>
  (body && (body.msg || body.message || body.error_description || body.error)) || ('HTTP ' + status);

async function createLogin(env: Env, f: Fetch, row: CleanRow, mode: Mode): Promise<Login> {
  const meta = { first_name: row.first_name, last_name: row.last_name, company_name: row.company_name };

  if (mode === 'invite') {
    const q = env.siteUrl ? '?redirect_to=' + encodeURIComponent(env.siteUrl) : '';
    const res = await f(env.url + '/auth/v1/invite' + q, {
      method: 'POST',
      headers: serviceHeaders(env),
      body: JSON.stringify({ email: row.email, data: meta })
    });
    const body = await readJson(res);
    if (res.ok) return { status: 'invited', userId: body && body.id };
    if (alreadyExists(res.status, body)) return { status: 'existing' };
    return { error: errText(body, res.status) };
  }

  // 'file' uses the row's own password; 'password' generates one. Only a
  // generated password is ever returned to the browser.
  const password = mode === 'file' ? String(row.password) : tempPassword();
  const res = await f(env.url + '/auth/v1/admin/users', {
    method: 'POST',
    headers: serviceHeaders(env),
    body: JSON.stringify({ email: row.email, password, email_confirm: true, user_metadata: meta })
  });
  const body = await readJson(res);
  if (res.ok) return { status: 'created', userId: body && body.id, password: mode === 'file' ? undefined : password };
  if (alreadyExists(res.status, body)) return { status: 'existing' };
  return { error: errText(body, res.status) };
}

/**
 * Upsert the clients row. Columns left out of the body are not touched, so a
 * re-import never clears is_admin, and a row with no sheet keeps the one it had.
 */
async function upsertClient(env: Env, f: Fetch, row: CleanRow): Promise<string | null> {
  const body: Json = {
    email: row.email,
    first_name: row.first_name,
    last_name: row.last_name,
    company_name: row.company_name,
    full_name: row.full_name
  };
  if (row.sheet_id) body.sheet_id = row.sheet_id;
  if (row.user_id) body.user_id = row.user_id;   // links the row to its login

  const res = await f(env.url + '/rest/v1/clients?on_conflict=email', {
    method: 'POST',
    headers: serviceHeaders(env, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify(body)
  });
  if (res.ok) return null;
  const err = await readJson(res);
  return errText(err, res.status);
}

async function doImport(env: Env, f: Fetch, users: unknown, mode: unknown): Promise<Response> {
  if (!Array.isArray(users) || !users.length) return reply(400, { error: 'No users to import.' });
  if (users.length > MAX_USERS_PER_IMPORT) {
    return reply(400, { error: 'At most ' + MAX_USERS_PER_IMPORT + ' users per import.' });
  }
  if (mode !== 'file' && mode !== 'invite' && mode !== 'password') {
    return reply(400, { error: 'mode must be "file", "password" or "invite".' });
  }

  const results: ImportResult[] = [];
  const seen = new Set<string>();

  // One at a time: a handful of users does not need concurrency, and Supabase
  // Auth rate-limits bursts.
  for (let i = 0; i < users.length; i++) {
    const c = cleanRow(users[i], env.defaultSheet, mode);
    const row = c.row;
    const email = row ? row.email : String((users[i] || {}).email || '').trim();
    if (c.error || !row) { results.push({ line: i + 1, email, status: 'error', error: c.error || 'invalid row' }); continue; }
    if (seen.has(row.email)) { results.push({ line: i + 1, email, status: 'error', error: 'duplicate in this import' }); continue; }
    seen.add(row.email);

    let login: Login;
    try { login = await createLogin(env, f, row, mode); }
    catch (e) { login = { error: messageOf(e) }; }
    if (login.error) { results.push({ line: i + 1, email, status: 'error', error: login.error }); continue; }
    if (login.userId) row.user_id = login.userId;

    let upErr: string | null;
    try { upErr = await upsertClient(env, f, row); }
    catch (e) { upErr = messageOf(e); }
    if (upErr) {
      results.push({ line: i + 1, email, status: 'error', error: 'login created but access not granted: ' + upErr });
      continue;
    }

    const out: ImportResult = { line: i + 1, email, status: login.status, sheet: row.sheet_id };
    if (login.password) out.password = login.password;
    results.push(out);
  }

  const count = (s: string): number => results.filter(r => r.status === s).length;
  return reply(200, {
    results,
    summary: { invited: count('invited'), created: count('created'), existing: count('existing'), errors: count('error') }
  });
}

async function doList(env: Env, f: Fetch): Promise<Response> {
  const res = await f(
    env.url + '/rest/v1/clients?select=email,first_name,last_name,company_name,full_name,sheet_id,is_admin,created_at&order=created_at.desc',
    { headers: serviceHeaders(env) }
  );
  if (!res.ok) return reply(502, { error: 'Could not read users (HTTP ' + res.status + ').' });
  return reply(200, { users: (await readJson(res)) || [] });
}

/** Revoke access: drop the clients row (no data) and delete the login (no sign-in). */
async function doRemove(env: Env, f: Fetch, email: unknown, caller: string): Promise<Response> {
  const target = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(target)) return reply(400, { error: 'A valid email is required.' });
  if (target === caller) return reply(400, { error: 'You cannot remove your own access.' });

  const del = await f(env.url + '/rest/v1/clients?email=eq.' + encodeURIComponent(target), {
    method: 'DELETE',
    headers: serviceHeaders(env, { Prefer: 'return=minimal' })
  });
  if (!del.ok) return reply(502, { error: 'Could not remove access (HTTP ' + del.status + ').' });

  let loginDeleted = false;
  for (let page = 1; page <= 10 && !loginDeleted; page++) {
    const res = await f(env.url + '/auth/v1/admin/users?per_page=1000&page=' + page, { headers: serviceHeaders(env) });
    if (!res.ok) break;
    const body = await readJson(res);
    const users: Json[] = (body && body.users) || [];
    const hit = users.find(u => String(u.email || '').toLowerCase() === target);
    if (hit) {
      const d = await f(env.url + '/auth/v1/admin/users/' + encodeURIComponent(hit.id), {
        method: 'DELETE', headers: serviceHeaders(env)
      });
      loginDeleted = d.ok;
    }
    if (users.length < 1000) break;
  }
  return reply(200, { removed: target, loginDeleted });
}

/** Request → Response. `env` and `f` are passed in so tests can run it under Node. */
export async function handle(req: Request, envIn: Partial<Env>, f?: Fetch): Promise<Response> {
  const fetcher: Fetch = f || ((input, init) => fetch(input, init));
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return reply(405, { error: 'Method not allowed' });

  const env: Env = {
    url: String(envIn.url || '').replace(/\/+$/, ''),
    key: String(envIn.key || ''),
    siteUrl: envIn.siteUrl || '',
    defaultSheet: envIn.defaultSheet || ''
  };
  if (!env.url || !env.key) {
    return reply(500, { error: 'User management is not configured: the function could not read the project URL or secret key.' });
  }

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!token) return reply(401, { error: 'Sign in first.' });

  let caller: string | null = null;
  try { caller = await callerEmail(env, fetcher, token); } catch (_) { caller = null; }
  if (!caller) return reply(401, { error: 'Your session has expired. Sign in again.' });

  let admin: Json | null = null;
  try { admin = await adminRow(env, fetcher, caller); } catch (_) { admin = null; }
  if (!admin) return reply(403, { error: 'Only dashboard admins can manage users.' });

  // Someone imported without a Sheet link gets NO sheet: their dashboard is
  // blank until they connect their own. (This used to hand them the importing
  // admin's sheet, which showed Greg's figures to every new user.)

  let body: Json;
  try { body = await req.json(); }
  catch (_) { return reply(400, { error: 'Request body must be JSON.' }); }

  try {
    if (body.action === 'list') return await doList(env, fetcher);
    if (body.action === 'import') return await doImport(env, fetcher, body.users, body.mode);
    if (body.action === 'remove') return await doRemove(env, fetcher, body.email, caller);
    return reply(400, { error: 'Unknown action.' });
  } catch (e) {
    return reply(502, { error: 'Supabase request failed: ' + messageOf(e) });
  }
}

/**
 * The secret key Supabase injects. Projects on the new API keys expose them as
 * SUPABASE_SECRET_KEYS (JSON, keyed by name); older projects as
 * SUPABASE_SERVICE_ROLE_KEY. Either works.
 */
export function secretFromEnv(get: (name: string) => string | undefined): string {
  const json = get('SUPABASE_SECRET_KEYS');
  if (json) {
    try {
      const keys = JSON.parse(json);
      if (keys && typeof keys === 'object') {
        const k = keys['default'] || Object.values(keys)[0];
        if (k) return String(k);
      }
    } catch (_) { /* fall through to the legacy variable */ }
  }
  return get('SUPABASE_SERVICE_ROLE_KEY') || '';
}

// On Supabase (Deno) serve requests; under Node (tests) just export.
if (typeof Deno !== 'undefined') {
  const deno = Deno;
  deno.serve((req: Request) => handle(req, {
    url: deno.env.get('SUPABASE_URL') || '',
    key: secretFromEnv((n) => deno.env.get(n)),
    siteUrl: deno.env.get('SITE_URL') || '',
    defaultSheet: deno.env.get('DEFAULT_SHEET_ID') || ''
  }));
}
