// index.html pulls Chart.js and the Supabase SDK from CDNs. stub.js installs
// deterministic stand-ins via addInitScript, but those run BEFORE the page's
// own <script src=...> tags — so if the CDNs actually load, the real libraries
// overwrite the stubs. The real Supabase client then tries to sign in against
// the live project, gets "Invalid login credentials", and the whole suite
// fails at the login step.
//
// That made every browser test quietly network-dependent: green on a machine
// with no internet, red on one with. Block the CDNs so the stubs always win.
module.exports = async function isolate(page) {
  await page.route(
    (url) => /(^|\.)cdn\.jsdelivr\.net$|(^|\.)fonts\.googleapis\.com$|(^|\.)fonts\.gstatic\.com$/.test(url.hostname),
    (route) => route.abort()
  );
};
