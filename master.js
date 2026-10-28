/*
 * master.js — master dashboard (master.html)
 *
 * Signs in with a real email/password account, verifies it against the master_users table,
 * then lists notebooks straight from the database (search, sort, pagination, live updates).
 * Every request is still checked by Row Level Security on the server.
 */
(function () {
  'use strict';

  var NB = window.NB, h = NB.h, C = window.NBCore, cfg = NB.cfg;
  var root = document.getElementById('app');
  var PAGE = Math.max(5, Math.min(50, parseInt(cfg.PAGE_SIZE, 10) || 12));

  var SORTS = {
    updated_desc: { label: 'Last saved — newest first', col: 'updated_at', asc: false },
    updated_asc: { label: 'Last saved — oldest first', col: 'updated_at', asc: true },
    name_asc: { label: 'Name A → Z', col: 'filename', asc: true },
    name_desc: { label: 'Name Z → A', col: 'filename', asc: false },
    created_desc: { label: 'Recently created', col: 'created_at', asc: false }
  };

  var M = {
    client: null, user: null, page: 0, q: '', sort: 'updated_desc', total: 0, rows: [], owners: {},
    loading: false, error: null, reqId: 0, channel: null, live: false, reloadTimer: null, searchTimer: null,
    prevRev: {}, flash: {}, menuOpen: false, dashboard: false
  };
  var els = {};

  function validNext(n) {
    return typeof n === 'string' && /^index\.html\?[A-Za-z0-9_=&%.\-]+$/.test(n) && n.indexOf('notebook_id=') !== -1;
  }
  function nextParam() { return new URLSearchParams(location.search).get('next'); }

  /* ================================================================== boot */

  async function boot() {
    if (!NB.preflight(root)) return;
    M.client = NB.createClient(NB.KEY_MASTER);
    M.client.auth.onAuthStateChange(function (ev) {
      if (ev === 'SIGNED_OUT' && M.dashboard) { teardown(); showLogin('Your session ended. Please sign in again.'); }
    });
    try {
      var s = await M.client.auth.getSession();
      var session = s.data && s.data.session;
      if (session && !session.user.is_anonymous) {
        M.user = session.user;
        if (await NB.checkMaster(M.client, M.user.id)) { onAuthorized(); return; }
        await M.client.auth.signOut();
        showLogin('This account is not a master account.');
        return;
      }
    } catch (e) {
      if (NB.isNetworkError(e)) {
        NB.showFatal(root, { title: "Can't reach the server", message: 'Check your internet connection and try again.', details: e && e.message,
          actions: [{ label: 'Try again', primary: true, onClick: function () { location.reload(); } }] });
        return;
      }
    }
    showLogin('');
  }

  function onAuthorized() {
    var next = nextParam();
    if (validNext(next)) { location.replace(next); return; }
    showDashboard();
  }

  /* ================================================================== login */

  function showLogin(message) {
    M.dashboard = false;
    root.textContent = '';
    var email = h('input', { class: 'input', type: 'email', name: 'email', autocomplete: 'username', required: true, inputmode: 'email', autocapitalize: 'off', spellcheck: 'false', 'data-autofocus': '1' });
    var pw = h('input', { class: 'input', type: 'password', name: 'password', autocomplete: 'current-password', required: true });
    var toggle = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Show password', title: 'Show password', on: { click: function () {
      var show = pw.type === 'password'; pw.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    } } }, NB.icon('eye', 20));
    var err = h('p', { class: 'form-error', role: 'alert', text: message || '' });
    var btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Sign in');

    var form = h('form', { novalidate: true, on: { submit: async function (e) {
      e.preventDefault();
      err.textContent = '';
      if (!email.value.trim() || !pw.value) { err.textContent = 'Enter your email and password.'; return; }
      btn.disabled = true; btn.replaceChildren(h('span', { class: 'spinner' }), 'Signing in…');
      try {
        var r = await M.client.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
        if (r.error) throw r.error;
        M.user = r.data.user;
        var ok = await NB.checkMaster(M.client, M.user.id);
        if (!ok) { await M.client.auth.signOut(); throw new Error('This account is not a master account.'); }
        pw.value = '';
        onAuthorized();
      } catch (ex) {
        err.textContent = NB.isNetworkError(ex) ? "Can't reach the server. Check your connection." :
          /invalid login/i.test(ex.message || '') ? 'Wrong email or password.' : (ex.message || 'Could not sign in.');
        btn.disabled = false; btn.replaceChildren('Sign in');
      }
    } } },
      h('label', {}, h('span', { text: 'Email' }), email),
      h('label', {}, h('span', { text: 'Password' }), h('div', { class: 'pw-row' }, pw, toggle)),
      err, btn);

    root.appendChild(h('div', { class: 'login-wrap' },
      h('div', { class: 'login-theme' }, NB.themeButton()),
      h('div', { class: 'login-card' },
        h('div', { class: 'logo-lg' }, NB.icon('lock', 26)),
        h('h1', { text: 'Master sign in' }),
        h('p', { class: 'sub', text: 'Manage and edit every notebook.' }),
        form,
        h('p', { class: 'login-foot' }, 'Not a master? ', h('a', { href: 'index.html', text: 'Open your notebook' })))));
    email.focus();
  }

  /* =============================================================== dashboard */

  function sanitizeQuery(q) {
    return String(q || '').replace(/[%*,()\\"'`;]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  function showDashboard() {
    M.dashboard = true;
    root.textContent = '';

    els.live = h('span', { class: 'live-chip', text: 'Offline' });
    els.avatar = h('button', { class: 'm-avatar', type: 'button', 'aria-label': 'Account menu', 'aria-haspopup': 'menu', 'aria-expanded': 'false', on: { click: toggleMenu } },
      ((M.user && M.user.email) || 'M').charAt(0).toUpperCase());
    els.menu = h('div', { class: 'm-menu', role: 'menu', hidden: true },
      h('div', { class: 'who', text: (M.user && M.user.email) || 'Master' }),
      h('button', { type: 'button', role: 'menuitem', on: { click: signOut } }, NB.icon('logout', 20), 'Sign out'));

    var top = h('header', { class: 'm-top' },
      h('div', { class: 'm-brand' }, h('span', { class: 'logo-sm' }, NB.icon('lock', 18)), h('h1', {}, 'Master', h('span', { class: 'h1-long', text: ' dashboard' }))),
      els.live,
      NB.themeButton(),
      h('button', { class: 'icon-btn', type: 'button', title: 'Refresh', 'aria-label': 'Refresh', on: { click: function () { load(); } } }, NB.icon('refresh', 22)),
      h('div', { class: 'm-user' }, els.avatar, els.menu));

    els.search = h('input', { class: 'input', type: 'search', placeholder: 'Search by notebook or owner name', 'aria-label': 'Search notebooks', autocomplete: 'off', enterkeyhint: 'search',
      on: { input: function () {
        clearTimeout(M.searchTimer);
        M.searchTimer = setTimeout(function () { M.q = els.search.value; M.page = 0; load(); }, 300);
      } } });
    els.sort = h('select', { class: 'input m-select', 'aria-label': 'Sort notebooks', on: { change: function () { M.sort = els.sort.value; M.page = 0; load(); } } },
      Object.keys(SORTS).map(function (k) { return h('option', { value: k, text: SORTS[k].label }); }));

    els.summary = h('div', { class: 'm-summary', 'aria-live': 'polite' });
    els.list = h('div', { class: 'nb-list' });
    els.pager = h('div', { class: 'm-pager' });

    root.appendChild(top);
    root.appendChild(h('main', { class: 'm-main' },
      h('div', { class: 'm-controls' }, h('div', { class: 'm-search' }, NB.icon('search', 20), els.search), els.sort),
      els.summary, els.list, els.pager));

    document.addEventListener('mousedown', function (e) {
      if (M.menuOpen && !e.target.closest('.m-user')) toggleMenu(false);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && M.menuOpen) toggleMenu(false); });
    window.addEventListener('online', function () { if (M.dashboard) load(); });
    setInterval(function () { if (M.dashboard && !M.loading && M.rows.length) renderList(); }, 30000);

    load();
    subscribe();
  }

  function toggleMenu(force) {
    M.menuOpen = typeof force === 'boolean' ? force : !M.menuOpen;
    els.menu.hidden = !M.menuOpen;
    els.avatar.setAttribute('aria-expanded', String(M.menuOpen));
  }

  function teardown() {
    try { if (M.channel) M.client.removeChannel(M.channel); } catch (e) { /* ignore */ }
    M.channel = null; M.live = false; M.dashboard = false;
    clearTimeout(M.reloadTimer);
  }

  async function signOut() {
    teardown();
    try { await M.client.auth.signOut(); } catch (e) { /* ignore */ }
    showLogin('');
  }

  /* ----------------------------------------------------------------- data */

  async function load() {
    var my = ++M.reqId;
    M.loading = true; M.error = null;
    renderList();
    try {
      var s = sanitizeQuery(M.q), ownerIds = [];
      if (s) {
        var pr = await M.client.from('profiles').select('id').ilike('display_name', '%' + s + '%').limit(50);
        if (!pr.error && pr.data) ownerIds = pr.data.map(function (r) { return r.id; });
      }
      var q = M.client.from('notebooks')
        .select('id, owner_id, filename, revision, created_at, updated_at, last_edited_by', { count: 'exact' })
        .is('deleted_at', null);
      if (s) {
        var f = 'filename.ilike.*' + s + '*';
        if (ownerIds.length) f += ',owner_id.in.(' + ownerIds.join(',') + ')';
        q = q.or(f);
      }
      var so = SORTS[M.sort] || SORTS.updated_desc;
      q = q.order(so.col, { ascending: so.asc }).order('id').range(M.page * PAGE, M.page * PAGE + PAGE - 1);
      var res = await q;
      if (my !== M.reqId) return;
      if (res.error) throw res.error;
      var rows = res.data || [];
      M.total = res.count || 0;
      if (!rows.length && M.page > 0 && M.total > 0) { M.page = Math.max(0, Math.ceil(M.total / PAGE) - 1); return load(); }

      var ids = {}; rows.forEach(function (r) { ids[r.owner_id] = true; });
      var idList = Object.keys(ids);
      if (idList.length) {
        var po = await M.client.from('profiles').select('id, display_name').in('id', idList);
        if (my !== M.reqId) return;
        if (!po.error && po.data) po.data.forEach(function (p) { M.owners[p.id] = p.display_name || ''; });
      }
      M.flash = {};
      rows.forEach(function (r) {
        if (M.prevRev[r.id] !== undefined && M.prevRev[r.id] !== r.revision) M.flash[r.id] = true;
        M.prevRev[r.id] = r.revision;
      });
      M.rows = rows;
    } catch (e) {
      if (my !== M.reqId) return;
      M.error = e || new Error('Unknown error');
    } finally {
      if (my === M.reqId) { M.loading = false; renderList(); }
    }
  }

  function scheduleReload() {
    clearTimeout(M.reloadTimer);
    M.reloadTimer = setTimeout(function () { if (M.dashboard && !M.loading) load(); else if (M.dashboard) scheduleReload(); }, 600);
  }

  function subscribe() {
    if (M.channel) return;
    try {
      M.channel = M.client.channel('master-notebooks-' + Math.random().toString(36).slice(2, 8))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notebooks' }, scheduleReload)
        .subscribe(function (status) {
          var on = status === 'SUBSCRIBED';
          if (on && M.hadDrop) { M.hadDrop = false; scheduleReload(); }
          if (!on && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) M.hadDrop = true;
          M.live = on;
          els.live.classList.toggle('on', on);
          els.live.textContent = on ? 'Live' : 'Offline';
          els.live.title = on ? 'New and renamed notebooks appear automatically' : 'Live updates are off — use Refresh';
        });
    } catch (e) { /* the dashboard still works without realtime */ }
  }

  /* --------------------------------------------------------------- render */

  function ownerLabel(id) { return M.owners[id] || ('Guest ' + NB.shortId(id)); }

  function hue(id) {
    var n = 0, s = String(id); for (var i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) % 360;
    return n;
  }

  function rowEl(n) {
    var now = Date.now(), age = now - new Date(n.updated_at).getTime();
    var active = age < 120000, byMaster = n.last_edited_by && n.last_edited_by !== n.owner_id;
    var label = ownerLabel(n.owner_id);
    var av = h('span', { class: 'avatar-sm', 'aria-hidden': 'true', text: label.replace(/^Guest /, 'G').charAt(0).toUpperCase() });
    av.style.background = 'hsl(' + hue(n.owner_id) + ' 55% 42%)';
    var href = 'index.html?notebook_id=' + encodeURIComponent(n.id) + '&mode=master';
    return h('article', { class: 'nb-row' + (M.flash[n.id] ? ' flash' : ''), data: { id: n.id } },
      h('div', { class: 'c-name' },
        h('a', { class: 'nb-link', href: href, text: n.filename }),
        h('div', { class: 'nb-sub', text: 'rev ' + n.revision + ' · ' + NB.shortId(n.id) })),
      h('div', { class: 'c-owner', title: n.owner_id }, av, h('span', { class: 'ow-name', text: label })),
      h('div', { class: 'c-time', title: NB.absTime(n.updated_at), text: NB.relTime(n.updated_at, now) }),
      h('div', { class: 'c-status' },
        h('span', { class: 'pill ' + (active ? 'active' : 'synced'), text: active ? 'Active' : 'Synced' }),
        byMaster ? h('span', { class: 'pill master', text: 'Master edited' }) : null),
      h('div', { class: 'c-actions' },
        h('a', { class: 'btn btn-primary', href: href }, NB.icon('open', 18), 'Open'),
        h('button', { class: 'icon-btn danger', type: 'button', title: 'Delete notebook', 'aria-label': 'Delete ' + n.filename, on: { click: function () { deleteNb(n); } } }, NB.icon('delete', 20))));
  }

  function renderList() {
    if (!els.list) return;
    els.list.textContent = '';
    els.pager.textContent = '';

    if (M.loading && !M.rows.length) {
      els.summary.textContent = 'Loading…';
      for (var i = 0; i < 4; i++) els.list.appendChild(h('div', { class: 'skeleton-row' }));
      return;
    }
    if (M.error) {
      var offline = NB.isNetworkError(M.error);
      els.summary.textContent = '';
      els.list.appendChild(h('div', { class: 'state-box' },
        NB.icon('warning', 32),
        h('h2', { text: offline ? 'You appear to be offline' : 'Could not load notebooks' }),
        h('p', { text: offline ? 'Check your connection and try again.' : ((M.error.message) || 'Something went wrong.') }),
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Retry', on: { click: function () { load(); } } })));
      return;
    }

    var from = M.total ? M.page * PAGE + 1 : 0, to = M.page * PAGE + M.rows.length;
    els.summary.textContent = M.total
      ? (sanitizeQuery(M.q) ? M.total + (M.total === 1 ? ' match' : ' matches') : M.total + (M.total === 1 ? ' notebook' : ' notebooks')) + (M.loading ? ' · updating…' : '')
      : '';

    if (!M.rows.length) {
      var searching = !!sanitizeQuery(M.q);
      els.list.appendChild(h('div', { class: 'state-box' },
        NB.icon('search', 32),
        h('h2', { text: searching ? 'No matching notebooks' : 'No notebooks yet' }),
        h('p', { text: searching ? 'Try a different name.' : 'When someone saves a notebook it appears here automatically.' })));
      return;
    }

    els.list.appendChild(h('div', { class: 'nb-head', 'aria-hidden': 'true' },
      h('div', { class: 'c-name', text: 'Notebook' }), h('div', { class: 'c-owner', text: 'Owner' }), h('div', { class: 'c-time', text: 'Last saved' }),
      h('div', { class: 'c-status', text: 'Status' }), h('div', { class: 'c-actions' })));
    M.rows.forEach(function (n) { els.list.appendChild(rowEl(n)); });

    if (M.total > PAGE) {
      var pages = Math.ceil(M.total / PAGE);
      els.pager.appendChild(h('button', { class: 'btn btn-outline', type: 'button', disabled: M.page === 0, on: { click: function () { M.page--; load(); window.scrollTo(0, 0); } } }, NB.icon('chevronLeft', 18), 'Prev'));
      els.pager.appendChild(h('span', { class: 'pg-info', text: from + '–' + to + ' of ' + M.total + ' · page ' + (M.page + 1) + '/' + pages }));
      els.pager.appendChild(h('button', { class: 'btn btn-outline', type: 'button', disabled: M.page >= pages - 1, on: { click: function () { M.page++; load(); window.scrollTo(0, 0); } } }, 'Next', NB.icon('chevronRight', 18)));
    }
  }

  async function deleteNb(n) {
    var ok = await NB.confirm('Delete this notebook?', '“' + n.filename + '” by ' + ownerLabel(n.owner_id) + ' will be removed and disappear from its owner’s workspace.', { okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      var r = await M.client.rpc('delete_notebook', { p_notebook_id: n.id });
      if (r.error) throw r.error;
      NB.toast('Notebook deleted', { kind: 'ok' });
      load();
    } catch (e) { NB.toast('Could not delete: ' + ((e && e.message) || 'error'), { kind: 'error' }); }
  }

  window.__master = { M: M, load: load };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
