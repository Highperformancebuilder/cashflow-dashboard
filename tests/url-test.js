// Extract the pure URL functions straight from index.html and exercise them.
const fs = require('fs');
const src = fs.readFileSync('/home/user/cashflow-dashboard/index.html', 'utf8');
const grab = (name) => {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('not found: ' + name);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') { depth--; if (started && depth === 0) return src.slice(i, j + 1); }
  }
};
const WORKING_SHEET_NAME = 'Business Working Account';
// One eval so buildFetchUrl can see candidateUrls.
eval([grab('parseSheetSource'), grab('candidateUrls'), grab('buildFetchUrl'), grab('sourceSummary')].join('\n'));

const ID = '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c';
let pass = 0, fail = 0;
const t = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '   [' + detail + ']' : '')); }
};

// --- accepted forms --------------------------------------------------------
const cases = [
  ['plain edit URL',            'https://docs.google.com/spreadsheets/d/' + ID + '/edit?usp=sharing', 'sheet', ID],
  ['edit URL with gid',         'https://docs.google.com/spreadsheets/d/' + ID + '/edit#gid=123456', 'sheet', ID],
  ['bare /d/ URL',              'https://docs.google.com/spreadsheets/d/' + ID, 'sheet', ID],
  ['view URL',                  'https://docs.google.com/spreadsheets/d/' + ID + '/view', 'sheet', ID],
  ['bare id',                   ID, 'sheet', ID],
  ['whitespace padded',         '   https://docs.google.com/spreadsheets/d/' + ID + '/edit   ', 'sheet', ID],
  ['apps script exec',          'https://script.google.com/macros/s/AKfycbzOauv605mtvkd7PrUG/exec', 'appsscript', null],
  ['apps script exec w/ query', 'https://script.google.com/macros/s/AKfycbzOauv605mtvkd7PrUG/exec?x=1', 'appsscript', null],
  ['published csv',             'https://docs.google.com/spreadsheets/d/e/2PACX-1vTEgXoNhYXil/pub?output=csv', 'published', null],
];
for (const [name, input, kind, id] of cases) {
  const r = parseSheetSource(input);
  t('accepts ' + name, r && !r.error && r.kind === kind && (!id || r.id === id), JSON.stringify(r));
}

t('extracts gid', parseSheetSource('https://docs.google.com/spreadsheets/d/' + ID + '/edit#gid=123456').gid === '123456');
t('no gid when absent', parseSheetSource('https://docs.google.com/spreadsheets/d/' + ID + '/edit').gid === null);
t('strips apps-script query',
  parseSheetSource('https://script.google.com/macros/s/AKfycbzOauv/exec?a=1').url === 'https://script.google.com/macros/s/AKfycbzOauv/exec');

// --- rejected forms --------------------------------------------------------
for (const [name, input] of [
  ['empty', ''], ['whitespace only', '   '], ['null', null], ['undefined', undefined],
  ['a google doc', 'https://docs.google.com/document/d/' + ID + '/edit'],
  ['a random site', 'https://evil.example.com/steal'],
  ['plain words', 'my cashflow sheet'],
  ['too-short id', 'abc123'],
  ['http sheet (not https)', 'http://docs.google.com/spreadsheets/d/' + ID],
]) {
  const r = parseSheetSource(input);
  t('rejects ' + name, r && !!r.error, JSON.stringify(r));
}

// --- URL construction ------------------------------------------------------
const sheetUrl = buildFetchUrl(parseSheetSource('https://docs.google.com/spreadsheets/d/' + ID + '/edit'));
t('sheet -> gviz endpoint', sheetUrl.startsWith('https://docs.google.com/spreadsheets/d/' + ID + '/gviz/tq'), sheetUrl);
t('sheet -> csv output', sheetUrl.includes('tqx=out:csv'), sheetUrl);
t('sheet -> headers=0 (no header row eaten)', sheetUrl.includes('headers=0'), sheetUrl);
t('sheet -> targets the working tab', sheetUrl.includes('sheet=Business%20Working%20Account'), sheetUrl);

// A gid copied from the address bar is just whichever tab was open, so the
// named tab must win. (This assertion previously asserted the opposite, which
// is exactly why connecting a real sheet failed.)
const gidSource = parseSheetSource('https://docs.google.com/spreadsheets/d/' + ID + '/edit#gid=99');
const gidUrl = buildFetchUrl(gidSource);
t('tab name takes precedence over a pasted gid', gidUrl.includes('sheet=Business%20Working%20Account'), gidUrl);
t('the gid is retained as a fallback candidate',
  candidateUrls(gidSource).some(u => u.includes('gid=99')), JSON.stringify(candidateUrls(gidSource)));

t('apps script passes through unchanged',
  buildFetchUrl(parseSheetSource('https://script.google.com/macros/s/AK/exec')) === 'https://script.google.com/macros/s/AK/exec');

const pubUrl = buildFetchUrl(parseSheetSource('https://docs.google.com/spreadsheets/d/e/2PACX-1vAbc/pub?output=csv'));
t('published keeps its query and adds csv', pubUrl.includes('output=csv') && pubUrl.startsWith('https://docs.google.com'), pubUrl);

t('null source -> null url', buildFetchUrl(null) === null);

// --- every built URL must survive the proxy allowlist ----------------------
const ALLOWED = new Set(['script.google.com', 'script.googleusercontent.com', 'docs.google.com']);
for (const [name, input] of cases.map(c => [c[0], c[1]])) {
  const all = candidateUrls(parseSheetSource(input));
  const bad = all.filter(u => !ALLOWED.has(new URL(u).hostname));
  t('proxy allows every candidate for ' + name, bad.length === 0, bad.join(', '));
}

// --- summary is safe on every shape ---------------------------------------
for (const [name, input] of cases.map(c => [c[0], c[1]])) {
  const sum = sourceSummary(parseSheetSource(input));
  t('summary renders for ' + name, typeof sum === 'string' && sum.length > 0, sum);
}

console.log('\n' + pass + '/' + (pass + fail) + ' passed');
process.exit(fail ? 1 : 0);
