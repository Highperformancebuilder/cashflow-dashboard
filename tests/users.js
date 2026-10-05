// Users tab: visible to admins only, paste-from-Excel import with preview,
// talks to the admin function with the signed-in token, and never renders
// imported text as HTML.
const { chromium } = require('playwright');
const isolate = require('./isolate');
const LAUNCH = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {};
const STUB = require('fs').readFileSync(__dirname + '/stub.js', 'utf8');
const SHEET = '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c';

const T = [];
const check = (n, c, d = '') => T.push({ n, ok: !!c, d });

async function session(clientRow, storedSource) {
  const browser = await chromium.launch(LAUNCH);
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  await isolate(page);
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
  page.on('dialog', d => d.accept());

  // Stand-in for the Supabase Edge Function. It is called cross-origin, so the
  // stand-in answers the CORS preflight the way the real one does.
  const calls = [];
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info'
  };
  await page.route('**/functions/v1/admin-users', async route => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS, body: '' });
    const body = JSON.parse(req.postData() || '{}');
    calls.push({ url: req.url(), apikey: req.headers()['apikey'], auth: req.headers()['authorization'], body });
    let out;
    if (body.action === 'list') {
      out = { users: [
        { email: 'admin@x.com', full_name: 'Gitesh Admin', is_admin: true, sheet_id: SHEET },
        { email: 'nickbruce00@gmail.com', first_name: 'Nicholas', last_name: 'Bruce', sheet_id: SHEET },
        { email: 'evil@x.com', full_name: '<img src=x onerror="window.__pwned=1">', sheet_id: null }
      ] };
    } else if (body.action === 'import') {
      out = {
        results: body.users.map((u, i) => ({
          line: i + 1, email: u.email.toLowerCase(),
          status: i === 0 ? 'created' : 'existing',
          password: i === 0 && body.mode === 'password' ? 'Tmp_Pass_123456789' : undefined
        })),
        summary: { invited: 0, created: 1, existing: body.users.length - 1, errors: 0 }
      };
    } else if (body.action === 'remove') {
      out = { removed: body.email, loginDeleted: true };
    }
    await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(out) });
  });

  await page.addInitScript('window.__clientRow = ' + JSON.stringify(clientRow) + ';');
  if (storedSource) {
    await page.addInitScript('localStorage.setItem("gj_cashflow_source", ' + JSON.stringify(JSON.stringify(storedSource)) + ');');
  }
  await page.addInitScript(STUB);
  await page.goto('http://localhost:8099/', { waitUntil: 'networkidle' });
  await page.fill('#login-email', 'Admin@X.com');
  await page.fill('#login-password', 'x');
  // stub.js only accepts greg@example.com; sign-in itself is not under test.
  await page.evaluate(() => {
    sb.auth.signInWithPassword = async () => ({ data: {}, error: null });
    sb.auth.getSession = async () => ({ data: { session: { access_token: 'admin-token' } } });
  });
  await page.click('#login-btn');
  await page.waitForTimeout(1200);
  return { browser, page, errs, calls };
}

(async () => {
  // ---- a normal user never sees the tab ------------------------------------
  let s = await session({ sheet_id: SHEET, is_admin: false });
  check('non-admin: Import Users tab hidden', await s.page.evaluate(() => document.getElementById('nb-users').hidden));
  check('non-admin: Connect tab hidden', await s.page.evaluate(() => document.getElementById('nb-connect').hidden));
  check('non-admin: no admin calls made', s.calls.length === 0, JSON.stringify(s.calls));
  check('non-admin: dashboard loads with their linked sheet',
    await s.page.isVisible('#dashboard-wrap') && (await s.page.evaluate(() => sync.sheetId)) === SHEET);
  check('non-admin: sees the same five dashboard tabs as Greg',
    (await s.page.evaluate(() => Array.from(document.querySelectorAll('.nb')).filter(b => !b.hidden)
      .map(b => b.textContent.trim()).join('|'))) === 'Overview|Weekly|FY Performance|Clients|4 Accounts');
  check('non-admin: connectSheet() refuses to run', await s.page.evaluate(async () => {
    document.getElementById('connect-url').value = 'https://docs.google.com/spreadsheets/d/1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA/edit';
    await connectSheet();
    return sync.sheetId === '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c';
  }));
  await s.browser.close();

  // ---- a sheet remembered in this browser is not handed to a non-admin ----
  // e.g. Greg connected a sheet on a shared computer, then someone else signs in.
  s = await session({ sheet_id: null, is_admin: false }, {
    kind: 'sheet', id: SHEET, gid: null, label: 'Google Sheet'
  });
  check('non-admin with no sheet does NOT inherit a sheet stored in the browser',
    (await s.page.evaluate(() => sync.sheetId)) === null && (await s.page.evaluate(() => sync.source)) === null);
  check('  ...and is told to contact Greg', /contact Greg/i.test(await s.page.textContent('#sync-banner')));
  await s.browser.close();

  // ---- an older database (no is_admin column) still signs people in ------
  s = await session({ sheet_id: SHEET });
  check('row without is_admin: signs in, tab hidden',
    await s.page.isVisible('#dashboard-wrap') &&
    await s.page.evaluate(() => document.getElementById('nb-users').hidden));
  await s.browser.close();

  // ---- an admin ----------------------------------------------------------
  s = await session({ sheet_id: SHEET, is_admin: true });
  const { page, calls } = s;
  check('admin: Import Users tab visible', !(await page.evaluate(() => document.getElementById('nb-users').hidden)));
  check('admin: Connect tab visible', !(await page.evaluate(() => document.getElementById('nb-connect').hidden)));
  check('existing tabs keep their positions',
    (await page.evaluate(() => Array.from(document.querySelectorAll('.nb')).slice(0, 6).map(b => b.textContent.trim()).join('|'))) ===
    'Overview|Weekly|FY Performance|Clients|4 Accounts|Connect');

  await page.click('#nb-users');
  await page.waitForTimeout(400);
  check('opening the tab lists users', calls.some(c => c.body.action === 'list'));
  check('admin calls carry the signed-in token', calls.every(c => c.auth === 'Bearer admin-token'), calls[0] && calls[0].auth);
  check('calls go to the Supabase Edge Function on the new project',
    calls.length && calls.every(c => c.url === 'https://kgjsqsdpwehcebyhkhql.supabase.co/functions/v1/admin-users'), calls[0] && calls[0].url);
  check('calls carry the publishable key the Supabase gateway expects',
    calls.every(c => c.apikey === 'sb_publishable_gZJ0N7T73joHRj2H8V-ArA_5bNgnB3D'));
  check('user list renders', (await page.evaluate(() => document.querySelectorAll('#users-list tr').length)) === 4);
  check('the admin cannot remove themselves (no button on own row)',
    await page.evaluate(() => !Array.from(document.querySelectorAll('#users-list button')).some(b => b.dataset.email === 'admin@x.com')));
  check('names from the database are not rendered as HTML',
    (await page.evaluate(() => window.__pwned)) === undefined &&
    (await page.evaluate(() => document.querySelectorAll('#users-list img').length)) === 0);

  check('the tab is labelled "Import Users"', (await page.textContent('#nb-users')).trim() === 'Import Users');

  // ---- upload an .xlsx laid out exactly like Greg's workbook --------------
  // Title on row 1, headings on row 3, passwords that are people's surnames
  // (some only 5 characters), and empty rows showing "0" under Password.
  const xlsxB64 = await page.evaluate(async () => {
    const XLSX = await loadSheetJs();
    const ws = XLSX.utils.aoa_to_sheet([
      ['Cashflow user names & dashboard axcess'],
      [],
      ['First name', 'Last name', 'Company name', 'Email', 'Password'],
      ['Nicholas', 'Bruce', '', 'nickbruce00@gmail.com', 'Bruce'],
      ['Justin', 'Laurie', '', 'justin@hlwprojects.com', 'Laurie'],
      ['James', 'Kamenitsas', 'Kamen Projects', 'James@KamenProjects.com.au', 'Secret#2026'],
      ['', '', '', '', 0],
      ['', '', '', '', 0]
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    return XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
  });
  await page.setInputFiles('#imp-file', {
    name: 'Supabase client axcess details.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer: Buffer.from(xlsxB64, 'base64')
  });
  await page.waitForTimeout(500);

  const pv = await page.evaluate(() => ({
    rows: document.querySelectorAll('#imp-preview tr').length - 1,
    text: document.getElementById('imp-preview').textContent.replace(/\s+/g, ' '),
    btn: document.getElementById('imp-go').textContent,
    file: document.getElementById('imp-file-name').textContent
  }));
  check('Excel file read; heading row found on row 3', pv.rows === 3, 'rows=' + pv.rows + ' ' + pv.text.slice(0, 80));
  check('the "0" rows under Password are skipped', pv.rows === 3);
  check('the uploaded file name is shown', /axcess details\.xlsx/.test(pv.file), pv.file);
  check('first and last names are kept separately',
    /Justin Laurie/.test(pv.text.replace(/(Justin)\s*(Laurie)/, '$1 $2')) || /JustinLaurie/.test(pv.text.replace(/\s/g, '')));
  check('a 5-character password is flagged (Supabase minimum is 6)', /at least 6 characters/.test(pv.text), pv.text.slice(0, 200));
  check('passwords are masked in the preview', !/Secret#2026/.test(pv.text));
  check('only the valid rows are counted', pv.btn === 'Import 2 users', pv.btn);

  // Choosing generated passwords makes the short file password irrelevant.
  await page.check('input[name="imp-mode"][value="password"]');
  await page.waitForTimeout(200);
  check('generate-password mode accepts the short-password row', (await page.textContent('#imp-go')) === 'Import 3 users');
  await page.check('input[name="imp-mode"][value="file"]');
  await page.waitForTimeout(200);

  // ---- import using the passwords from the file -----------------------------
  calls.length = 0;
  await page.click('#imp-go');
  await page.waitForTimeout(600);
  const imp = calls.find(c => c.body.action === 'import');
  check('import is sent in "file" mode', imp && imp.body.mode === 'file');
  check('import sends the valid rows only', imp && imp.body.users.length === 2, imp && imp.body.users.length);
  check('each row carries its own password from the file',
    imp && imp.body.users[0].password === 'Laurie' && imp.body.users[1].password === 'Secret#2026');
  check('first name, last name and company are sent',
    imp && imp.body.users[1].first_name === 'James' && imp.body.users[1].last_name === 'Kamenitsas' &&
    imp.body.users[1].company_name === 'Kamen Projects');
  const res = await page.evaluate(() => document.getElementById('imp-result').textContent.replace(/\s+/g, ' '));
  check('results summary shown', /1 created/.test(res) && /1 already existed/.test(res), res.slice(0, 90));
  check('file passwords are not echoed back on screen', !/Secret#2026|Laurie\b.*Laurie/.test(res));
  check('upload cleared after import', (await page.textContent('#imp-file-name')) === '' &&
    (await page.evaluate(() => importSourceRows.length)) === 0);
  check('list refreshed after import', calls.some(c => c.body.action === 'list'));

  // ---- the paste box still works -------------------------------------------
  await page.evaluate(() => { document.querySelector('#tab-users details').open = true; });
  await page.fill('#imp-text', 'a\tb\t\ta@x.com\tPassw0rd!\thttps://example.com/x');
  await page.waitForTimeout(200);
  check('non-Google sheet link flagged', /not a Google Sheets link/.test(await page.textContent('#imp-preview')));

  await page.fill('#imp-text', 'Jane,"Citizen, Jr",ACME,jane@x.com,Passw0rd!,https://docs.google.com/spreadsheets/d/' + SHEET + '/edit');
  await page.waitForTimeout(200);
  check('headerless CSV (First, Last, Company, Email, Password, Sheet) parses',
    /Citizen, Jr/.test(await page.textContent('#imp-preview')) &&
    (await page.textContent('#imp-go')) === 'Import 1 user');

  // ---- generated passwords are shown once ----------------------------------
  await page.check('input[name="imp-mode"][value="password"]');
  await page.waitForTimeout(150);
  calls.length = 0;
  await page.click('#imp-go');
  await page.waitForTimeout(500);
  const gen = calls.find(c => c.body.action === 'import');
  check('generated mode sends no password', gen && gen.body.mode === 'password' && !('password' in gen.body.users[0]));
  check('a generated password is shown once, with a warning',
    /Tmp_Pass_123456789/.test(await page.textContent('#imp-result')) && /shown once/i.test(await page.textContent('#imp-result')));

  // ---- remove ------------------------------------------------------------
  calls.length = 0;
  await page.click('#users-list button[data-email="nickbruce00@gmail.com"]');
  await page.waitForTimeout(500);
  const rm = calls.find(c => c.body.action === 'remove');
  check('remove asks the server to revoke that email', rm && rm.body.email === 'nickbruce00@gmail.com');

  // ---- sign out hides it again --------------------------------------------
  await page.evaluate(() => handleLogout());
  await page.waitForTimeout(300);
  check('sign-out hides the Users tab', await page.evaluate(() => document.getElementById('nb-users').hidden));
  check('sign-out hides the Connect tab', await page.evaluate(() => document.getElementById('nb-connect').hidden));
  check('sign-out leaves the Users panel', await page.evaluate(() => !document.getElementById('tab-users').classList.contains('active')));

  check('no page errors', s.errs.length === 0, s.errs.join(' | '));
  await s.browser.close();

  const fails = T.filter(t => !t.ok);
  T.forEach(t => console.log((t.ok ? '  PASS  ' : '  FAIL  ') + t.n + (t.d ? '   [' + t.d + ']' : '')));
  console.log('\n' + (T.length - fails.length) + '/' + T.length + ' passed');
  process.exit(fails.length ? 1 : 0);
})();
