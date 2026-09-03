// Deterministic stand-ins for the two CDN dependencies and the Supabase backend.
window.__charts = {};
window.__realtimeHandlers = [];
window.__log = [];

if (!window.__noChart) {
  window.Chart = function (canvas, config) {
    var id = canvas.id;
    // Mirror Chart.js v4: rebinding a live canvas is an error.
    if (window.__charts[id]) throw new Error('Canvas is already in use. Chart with ID "' + id + '" must be destroyed');
    this.id = id; this.config = config;
    window.__charts[id] = this;
    this.destroy = function () { delete window.__charts[id]; };
  };
  window.Chart.getChart = function (id) { return window.__charts[id] || null; };
}

if (!window.__noSupabase) {
  window.supabase = {
    createClient: function () {
      return {
        auth: {
          signInWithPassword: async function (c) {
            return c.email === 'greg@example.com'
              ? { data: { user: { email: c.email } }, error: null }
              : { data: null, error: { message: 'Invalid login credentials' } };
          },
          signOut: async function () { return { error: null }; },
          getSession: async function () { return { data: { session: null } }; },
          onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () { } } } }; }
        },
        from: function (table) {
          window.__log.push('from:' + table);
          var api = {
            select: function () { return api; },
            eq: function (c, v) { window.__log.push('eq:' + c + '=' + v); return api; },
            maybeSingle: async function () {
              if (table === 'clients') {
                if (window.__clientRow === null) return { data: null, error: null };
                if (window.__clientError) return { data: null, error: { message: 'permission denied' } };
                return {
                  data: window.__clientRow || {
                    sheet_id: '1MXTCOStUpHpGYrthqRb8NCuERbUIeyZcRZVvdG4P15c',
                    script_url: null
                  }, error: null
                };
              }
              return { data: null, error: null }; // no snapshot row -> use the proxy path
            }
          };
          return api;
        },
        channel: function (name) {
          window.__log.push('channel:' + name);
          var ch = {
            on: function (evt, cfg, cb) { window.__realtimeHandlers.push(cb); return ch; },
            subscribe: function (cb) { window.__subscribeCb = cb; return ch; }
          };
          return ch;
        },
        removeChannel: function () { window.__log.push('removeChannel'); }
      };
    }
  };
}
