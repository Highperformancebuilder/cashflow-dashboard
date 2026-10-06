// supabase/functions/admin-users (the Edge Function) against a fake Supabase.
// No network, no browser. The function file is plain JS in a .ts file, so Node
// loads the exact code Supabase runs.
const path = require('path');
const { pathToFileURL } = require('url');
const FN_PATH = path.resolve(__dirname, '..', 'supabase', 'functions', 'admin-users', 'index.ts');

// A small adapter so the checks below read like an HTTP handler test: env comes
// from process.env, exactly as Supabase supplies it to the function.
let fn;
async function loadFn() {
  const mod = await import(pathToFileURL(FN_PATH).href);
  let f = null;
  return {
    mod,
    _setFetch: (x) => { f = x; },
    _sheetIdFrom: mod.sheetIdFrom,
    handler: async (event) => {
      const req = new Request('https://proj.supabase.co/functions/v1/admin-users', {
        method: event.httpMethod,
        headers: event.headers || {},
        body: event.httpMethod === 'GET' || event.httpMethod === 'OPTIONS' ? undefined : event.body
      });
      const res = await mod.handle(req, {
        url: process.env.SUPABASE_URL,
        key: mod.secretFromEnv((n) => process.env[n]),
        siteUrl: process.env.SITE_URL || '',
        defaultSheet: process.env.DEFAULT_SHEET_ID || ''
      }, f);
      const text = await res.text();
      return { statusCode: res.status, headers: Object.fromEntries(res.headers), body: text || '{}' };
    }
  };
}

let pass = 0, fail = 0;
const t = (n, c, d = '') => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); } };

// ---- fake Supabase --------------------------------------------------------
function makeFake() {
  const s = {
    tokens: { 'admin-token': 'admin@x.com', 'user-token': 'user@x.com' },
    clients: {
      'admin@x.com': { email: 'admin@x.com', is_admin: true },
      'user@x.com':  { email: 'user@x.com',  is_admin: false }
    },
    logins: { 'admin@x.com': 'id-admin', 'user@x.com': 'id-user' },
    calls: [],
    failInviteFor: null
  };
  const res = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (body === undefined ? '' : JSON.stringify(body))
  });
  s.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const method = opts.method || 'GET';
    const body = opts.body ? JSON.parse(opts.body) : null;
    s.calls.push({ method, path: u.pathname, search: u.search, headers: opts.headers || {}, body });

    if (u.pathname === '/auth/v1/user') {
      const tok = String((opts.headers || {}).Authorization || '').replace('Bearer ', '');
      return s.tokens[tok] ? res(200, { email: s.tokens[tok] }) : res(401, { msg: 'bad jwt' });
    }
    if (u.pathname === '/rest/v1/clients' && method === 'GET') {
      const m = u.search.match(/email=eq\.([^&]+)/);
      if (m) {
        const row = s.clients[decodeURIComponent(m[1])];
        return res(200, row ? [row] : []);
      }
      return res(200, Object.values(s.clients));
    }
    if (u.pathname === '/rest/v1/clients' && method === 'POST') {
      const prev = s.clients[body.email] || {};
      s.clients[body.email] = Object.assign({}, prev, body);
      return res(201);
    }
    if (u.pathname === '/rest/v1/clients' && method === 'DELETE') {
      const m = u.search.match(/email=eq\.([^&]+)/);
      delete s.clients[decodeURIComponent(m[1])];
      return res(204);
    }
    if (u.pathname === '/auth/v1/invite') {
      if (body.email === s.failInviteFor) return res(500, { msg: 'Error sending invite email' });
      if (s.logins[body.email]) return res(422, { msg: 'A user with this email address has already been registered' });
      s.logins[body.email] = 'id-' + body.email;
      return res(200, { id: s.logins[body.email] });
    }
    if (u.pathname === '/auth/v1/admin/users' && method === 'POST') {
      if (s.logins[body.email]) return res(422, { code: 'email_exists' });
      s.logins[body.email] = 'id-' + body.email;
      return res(200, { id: s.logins[body.email] });
    }
    if (u.pathname === '/auth/v1/admin/users' && method === 'GET') {
      return res(200, { users: Object.keys(s.logins).map(e => ({ id: s.logins[e], email: e })) });
    }
    const del = u.pathname.match(/^\/auth\/v1\/admin\/users\/(.+)$/);
    if (del && method === 'DELETE') {
      const id = decodeURIComponent(del[1]);
      Object.keys(s.logins).forEach(e => { if (s.logins[e] === id) delete s.logins[e]; });
      return res(200, {});
    }
    return res(404, { msg: 'unhandled ' + method + ' ' + u.pathname });
  };
  return s;
}

const SHEET = '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c';
const call = (token, body, method = 'POST') => fn.handler({
  httpMethod: method,
  headers: token ? { authorization: 'Bearer ' + token } : {},
  body: JSON.stringify(body)
}).then(r => ({ status: r.statusCode, body: JSON.parse(r.body) }));

(async () => {
  fn = await loadFn();
  // ---- configuration ------------------------------------------------------
  delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let r = await call('admin-token', { action: 'list' });
  t('unconfigured function refuses with a clear message', r.status === 500 && /not configured/.test(r.body.error), r.body.error);

  // ---- the secret key Supabase injects --------------------------------------
  t('new API keys: secret read from SUPABASE_SECRET_KEYS',
    fn.mod.secretFromEnv(n => ({ SUPABASE_SECRET_KEYS: '{"default":"sb_secret_abc"}' })[n]) === 'sb_secret_abc');
  t('legacy keys: secret read from SUPABASE_SERVICE_ROLE_KEY',
    fn.mod.secretFromEnv(n => ({ SUPABASE_SERVICE_ROLE_KEY: 'legacy' })[n]) === 'legacy');
  t('new keys win when both are present',
    fn.mod.secretFromEnv(n => ({ SUPABASE_SECRET_KEYS: '{"default":"new"}', SUPABASE_SERVICE_ROLE_KEY: 'old' })[n]) === 'new');

  // ---- the browser calls it cross-origin ------------------------------------
  process.env.SUPABASE_URL = 'https://proj.supabase.co'; process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  const pre = await fn.handler({ httpMethod: 'OPTIONS', headers: {} });
  t('CORS preflight answered', pre.statusCode === 204 && /authorization/i.test(pre.headers['access-control-allow-headers'] || ''),
    JSON.stringify(pre.headers));

  process.env.SUPABASE_URL = 'https://proj.supabase.co/';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key';
  process.env.SITE_URL = 'https://site.example';
  delete process.env.DEFAULT_SHEET_ID;

  let s = makeFake(); fn._setFetch(s.fetch);

  // ---- who may call it ----------------------------------------------------
  r = await call(null, { action: 'list' });
  t('no token → 401', r.status === 401);
  r = await call('forged-token', { action: 'list' });
  t('invalid token → 401', r.status === 401);
  r = await call('user-token', { action: 'list' });
  t('signed-in NON-admin → 403', r.status === 403, JSON.stringify(r.body));
  r = await call('user-token', { action: 'import', mode: 'password', users: [{ email: 'evil@x.com' }] });
  t('non-admin cannot import', r.status === 403 && !s.logins['evil@x.com']);
  r = await call('admin-token', { action: 'list' }, 'GET');
  t('only POST is accepted', r.status === 405);

  // ---- list ---------------------------------------------------------------
  r = await call('admin-token', { action: 'list' });
  t('admin can list users', r.status === 200 && r.body.users.length === 2);
  t('service key is used server-side, never the caller token, for data',
    s.calls.filter(c => c.path.startsWith('/rest/')).every(c => c.headers.apikey === 'service-key'));

  // ---- import: password mode ---------------------------------------------
  s = makeFake(); fn._setFetch(s.fetch);
  r = await call('admin-token', {
    action: 'import', mode: 'password', users: [
      { first_name: 'Nicholas', last_name: 'Bruce', company_name: '', email: 'NickBruce00@Gmail.com', sheet: 'https://docs.google.com/spreadsheets/d/' + SHEET + '/edit#gid=0' },
      { first_name: 'Cam', last_name: 'Boyle', email: 'enquiries@kerabocarpentry.com', sheet: '' },
      { first_name: 'Bad', email: 'not-an-email' },
      { first_name: 'Dup', email: 'nickbruce00@gmail.com' },
      { first_name: 'Sheet', email: 'sheet@x.com', sheet: 'https://example.com/nope' },
      { first_name: 'Existing', email: 'user@x.com', company_name: 'Acme' }
    ]
  });
  const byEmail = {}; (r.body.results || []).forEach(x => { if (!byEmail[x.email]) byEmail[x.email] = x; });
  t('import returns 200 with per-row results', r.status === 200 && r.body.results.length === 6, JSON.stringify(r.body.summary));
  t('emails are lowercased', !!byEmail['nickbruce00@gmail.com'] && !!s.clients['nickbruce00@gmail.com']);
  t('new user created with a temporary password', byEmail['nickbruce00@gmail.com'].status === 'created' &&
    /^[A-Za-z0-9_-]{18}$/.test(byEmail['nickbruce00@gmail.com'].password), JSON.stringify(byEmail['nickbruce00@gmail.com']));
  t('temporary passwords are unique', byEmail['nickbruce00@gmail.com'].password !== byEmail['enquiries@kerabocarpentry.com'].password);
  const created = s.calls.find(c => c.path === '/auth/v1/admin/users' && c.method === 'POST');
  t('account is created confirmed (can sign in immediately)', created && created.body.email_confirm === true);
  t('sheet link is reduced to its id', s.clients['nickbruce00@gmail.com'].sheet_id === SHEET, s.clients['nickbruce00@gmail.com'].sheet_id);
  t('name fields stored', s.clients['nickbruce00@gmail.com'].full_name === 'Nicholas Bruce');
  t('invalid email rejected', byEmail['not-an-email'].status === 'error');
  t('duplicate within one import rejected', r.body.results[3].status === 'error' && /duplicate/.test(r.body.results[3].error));
  t('non-Google sheet link rejected', byEmail['sheet@x.com'].status === 'error' && !s.logins['sheet@x.com']);
  t('existing login reported, not recreated', byEmail['user@x.com'].status === 'existing' && !byEmail['user@x.com'].password);
  t('existing user’s details still updated', s.clients['user@x.com'].company_name === 'Acme');
  t('is_admin is never written by an import',
    s.calls.filter(c => c.path === '/rest/v1/clients' && c.method === 'POST').every(c => !('is_admin' in c.body)));
  t('re-import does not demote an admin', (await (async () => {
    await call('admin-token', { action: 'import', mode: 'password', users: [{ email: 'admin@x.com', first_name: 'Boss' }] });
    return s.clients['admin@x.com'].is_admin === true;
  })()));
  t('a blank sheet does not wipe an existing one', (await (async () => {
    s.clients['user@x.com'].sheet_id = SHEET;
    await call('admin-token', { action: 'import', mode: 'password', users: [{ email: 'user@x.com', sheet: '' }] });
    return s.clients['user@x.com'].sheet_id === SHEET;
  })()));
  t('summary counts are right', r.body.summary.created === 2 && r.body.summary.existing === 1 && r.body.summary.errors === 3,
    JSON.stringify(r.body.summary));

  // ---- import: passwords from Greg's file --------------------------------
  s = makeFake(); fn._setFetch(s.fetch);
  r = await call('admin-token', { action: 'import', mode: 'file', users: [
    { first_name: 'Justin', last_name: 'Laurie', email: 'justin@hlwprojects.com', password: 'Laurie' },
    { first_name: 'Nicholas', last_name: 'Bruce', email: 'nickbruce00@gmail.com', password: 'Bruce' },
    { first_name: 'No', last_name: 'Pass', email: 'nopass@x.com', password: '' }
  ] });
  const fileCreate = s.calls.find(c => c.path === '/auth/v1/admin/users' && c.method === 'POST');
  t('file mode: login created with the password from the file',
    r.body.results[0].status === 'created' && fileCreate && fileCreate.body.password === 'Laurie',
    JSON.stringify(r.body.results[0]));
  t('file mode: first/last name stored on the login too',
    fileCreate && fileCreate.body.user_metadata.first_name === 'Justin' && fileCreate.body.user_metadata.last_name === 'Laurie');
  t('file mode: the password is never sent back to the browser', !('password' in r.body.results[0]));
  t('file mode: the users table row is linked to the login', s.clients['justin@hlwprojects.com'].user_id === 'id-justin@hlwprojects.com',
    s.clients['justin@hlwprojects.com'].user_id);
  t('file mode: a 5-character password is refused before Supabase is called',
    r.body.results[1].status === 'error' && /at least 6/.test(r.body.results[1].error) && !s.logins['nickbruce00@gmail.com']);
  t('file mode: a missing password is refused', r.body.results[2].status === 'error' && /no password/.test(r.body.results[2].error));
  t('file mode: nothing is written for a refused row', !s.clients['nickbruce00@gmail.com'] && !s.clients['nopass@x.com']);

  // ---- import: invite mode -----------------------------------------------
  s = makeFake(); s.failInviteFor = 'bounce@x.com'; fn._setFetch(s.fetch);
  r = await call('admin-token', { action: 'import', mode: 'invite', users: [
    { email: 'new@x.com', first_name: 'New' }, { email: 'bounce@x.com' }
  ] });
  const inv = s.calls.find(c => c.path === '/auth/v1/invite');
  t('invite mode sends an invite', r.body.results[0].status === 'invited' && !r.body.results[0].password);
  t('invite redirects back to the site', inv && /redirect_to=https%3A%2F%2Fsite\.example/.test(inv.search), inv && inv.search);
  t('a failed invite is reported and grants no access',
    r.body.results[1].status === 'error' && !s.clients['bounce@x.com'], JSON.stringify(r.body.results[1]));

  // ---- no sheet link → NO sheet. Never the admin's. --------------------------
  const OWN_SHEET = '1' + 'B'.repeat(43);
  s = makeFake(); s.clients['admin@x.com'].sheet_id = SHEET; fn._setFetch(s.fetch);
  r = await call('admin-token', { action: 'import', mode: 'file', users: [
    { email: 'team@x.com', password: 'Stockley' },
    { email: 'own@x.com', password: 'Stockley', sheet: 'https://docs.google.com/spreadsheets/d/' + OWN_SHEET + '/edit' }
  ] });
  t('a user imported with no sheet link gets NO sheet (not the admin sheet)',
    s.clients['team@x.com'] && !s.clients['team@x.com'].sheet_id, JSON.stringify(s.clients['team@x.com']));
  t('  ...and the result reports no sheet', r.body.results[0].sheet === null);
  t('a user whose row HAS a sheet link still gets that sheet',
    s.clients['own@x.com'].sheet_id === OWN_SHEET);
  t('the admin own sheet is untouched', s.clients['admin@x.com'].sheet_id === SHEET);

  // ---- default sheet --------------------------------------------------------
  process.env.DEFAULT_SHEET_ID = SHEET;
  s = makeFake(); fn._setFetch(s.fetch);
  await call('admin-token', { action: 'import', mode: 'password', users: [{ email: 'blank@x.com' }] });
  t('DEFAULT_SHEET_ID fills a blank sheet', s.clients['blank@x.com'].sheet_id === SHEET);
  delete process.env.DEFAULT_SHEET_ID;

  // ---- limits and bad input ----------------------------------------------
  r = await call('admin-token', { action: 'import', mode: 'password', users: [] });
  t('empty import rejected', r.status === 400);
  r = await call('admin-token', { action: 'import', mode: 'sideways', users: [{ email: 'a@x.com' }] });
  t('unknown mode rejected', r.status === 400);
  r = await call('admin-token', { action: 'import', mode: 'password', users: Array.from({ length: 501 }, (_, i) => ({ email: i + '@x.com' })) });
  t('more than 500 rows rejected', r.status === 400);
  r = await call('admin-token', { action: 'drop-tables' });
  t('unknown action rejected', r.status === 400);

  // ---- remove ---------------------------------------------------------------
  s = makeFake(); fn._setFetch(s.fetch);
  r = await call('admin-token', { action: 'remove', email: 'USER@x.com' });
  t('admin can remove a user', r.status === 200 && r.body.loginDeleted === true);
  t('  ...their access row is gone', !s.clients['user@x.com']);
  t('  ...and their login is deleted', !s.logins['user@x.com']);
  r = await call('admin-token', { action: 'remove', email: 'admin@x.com' });
  t('an admin cannot remove themselves', r.status === 400 && s.clients['admin@x.com']);
  r = await call('user-token', { action: 'remove', email: 'admin@x.com' });
  t('a non-admin cannot remove anyone', r.status === 401 || r.status === 403);

  // ---- helpers --------------------------------------------------------------
  t('bare sheet id accepted', fn._sheetIdFrom(SHEET) === SHEET);
  t('blank sheet → null', fn._sheetIdFrom('') === null);
  t('junk sheet → undefined (error)', fn._sheetIdFrom('hello') === undefined);

  console.log('\n' + pass + '/' + (pass + fail) + ' passed');
  process.exit(fail ? 1 : 0);
})();
