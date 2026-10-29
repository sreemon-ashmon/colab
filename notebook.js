/*
 * notebook.js — Colab-style notebook editor (index.html)
 *
 * - Anonymous sign-in for normal visitors; master mode requires a real master account.
 * - All writes go through the SQL functions create_notebook / save_notebook / delete_notebook.
 * - Optimistic concurrency (revision) + 3-way merge, Realtime updates, autosave, local draft recovery.
 * - "Run" is a MOCK (see NBCore.mockRun). Real Python needs a separate sandboxed kernel.
 */
(function () {
  'use strict';

  var C = window.NBCore, NB = window.NB, h = NB.h, cfg = NB.cfg;
  var root = document.getElementById('app');

  var S = {
    client: null, user: null, isMaster: false, masterMode: false,
    nbId: null, ownerId: null, ownerName: '', revision: 0, seenRevision: 0,
    title: 'Untitled.ipynb', cells: [], base: { title: undefined, cells: [] },
    dirty: false, editVersion: 0, saving: false, saveAgain: false, saveError: null, retryCount: 0,
    saveTimer: null, retryTimer: null, draftTimer: null, refreshTimer: null, refreshing: false, refreshAgain: false,
    lastSavedAt: null, lastEditedBy: null, lastEditedAt: null,
    selectedId: null, readOnly: false, readOnlyReason: '', autosavePaused: false, pendingConflict: false,
    execCount: 0, env: {}, runtime: 'disconnected', running: {}, outputs: {}, stopAll: false,
    deleted: [], channel: null, live: false, hadDisconnect: false,
    chord: false, chordTimer: null, panel: null, menu: null, skipUnload: false, profileName: ''
  };
  var els = {};

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function nowIso() { return new Date().toISOString(); }
  function getCell(id) { for (var i = 0; i < S.cells.length; i++) if (S.cells[i].id === id) return S.cells[i]; return null; }
  function indexOfCell(id) { for (var i = 0; i < S.cells.length; i++) if (S.cells[i].id === id) return i; return -1; }
  function wrapOf(id) { return els.cells ? els.cells.querySelector('.cell-wrap[data-id="' + id + '"]') : null; }
  function snapshot() { return { title: S.title, cells: S.cells.map(C.cloneCell) }; }
  function cloneSnap(s) { return { title: s.title, cells: s.cells.map(C.cloneCell) }; }
  function me() { return S.user ? S.user.id : null; }
  function pageUrl(file, qs) { return file + (qs ? '?' + qs : ''); }

  /* ================================================================ boot */

  function fatal(title, message, details, actions) {
    NB.showFatal(root, { title: title, message: message, details: details, actions: actions || [{ label: 'Try again', primary: true, onClick: function () { location.reload(); } }] });
  }

  function showNotFound() {
    NB.showFatal(root, {
      icon: 'lock',
      title: 'Notebook not found',
      message: "This notebook doesn't exist, or you don't have access to it.",
      actions: S.masterMode
        ? [{ label: 'Back to dashboard', primary: true, href: 'master.html' }]
        : [{ label: 'New notebook', primary: true, href: 'index.html?new=1' }]
    });
  }

  async function boot() {
    if (!NB.preflight(root)) return;
    var params = new URLSearchParams(location.search);
    S.masterMode = params.get('mode') === 'master';
    S.client = NB.createClient(S.masterMode ? NB.KEY_MASTER : NB.KEY_USER);

    try {
      var sres = await S.client.auth.getSession();
      var session = sres.data && sres.data.session;

      if (S.masterMode) {
        // mode=master is only a REQUEST. Real authority is verified against the database.
        if (!session || session.user.is_anonymous) {
          location.replace('master.html?next=' + encodeURIComponent('index.html' + location.search));
          return;
        }
        S.user = session.user;
        S.isMaster = await NB.checkMaster(S.client, S.user.id);
        if (!S.isMaster) { showNotFound(); return; }
      } else {
        if (!session) {
          var r = await S.client.auth.signInAnonymously();
          if (r.error) {
            if (NB.isNetworkError(r.error)) { fatal("Can't reach the server", 'Check your internet connection and try again.', r.error.message); return; }
            fatal('Guest sign-in is turned off',
              'In Supabase open Authentication → Sign In / Providers and enable "Allow anonymous sign-ins", then reload this page.',
              r.error.message, [{ label: 'Reload', primary: true, onClick: function () { location.reload(); } }]);
            return;
          }
          session = r.data.session;
        }
        S.user = session.user;
      }

      S.client.auth.onAuthStateChange(function (ev, sess) {
        if (ev === 'SIGNED_OUT') { if (S.nbId) lockNotebook('You were signed out. Reload to continue.'); }
        else if (sess && sess.user) S.user = sess.user;
      });

      var id = params.get('notebook_id');
      var server = null;
      if (id) {
        if (!C.isUuid(id)) { showNotFound(); return; }
        server = await fetchServer(id);
        if (!server) { showNotFound(); return; }
      } else if (S.masterMode) {
        location.replace('master.html'); return;
      } else if (!params.get('new')) {
        var latest = await S.client.from('notebooks').select('id').eq('owner_id', S.user.id).is('deleted_at', null)
          .order('updated_at', { ascending: false }).limit(1);
        if (latest.error) throw latest.error;
        if (latest.data && latest.data.length) server = await fetchServer(latest.data[0].id);
      }

      buildUI();
      if (server) applyServer(server, { initial: true });
      else initNewDraft();
      afterLoad();
    } catch (e) {
      if (NB.isNetworkError(e)) fatal("Can't reach the server", 'Check your internet connection and try again.', e && e.message);
      else fatal('Something went wrong', 'The notebook could not be loaded.', (e && (e.message || e.code)) || String(e));
    }
  }

  /* ========================================================== server access */

  async function fetchServer(id) {
    for (var attempt = 0; attempt < 3; attempt++) {
      var a = await S.client.from('notebooks').select('id, owner_id, filename, revision, updated_at, last_edited_by, deleted_at').eq('id', id).maybeSingle();
      if (a.error) throw a.error;
      if (!a.data || a.data.deleted_at) return null;
      var c = await S.client.from('cells').select('id, cell_type, content, position, last_edited_by, updated_at').eq('notebook_id', id).order('position');
      if (c.error) throw c.error;
      var b = await S.client.from('notebooks').select('revision').eq('id', id).maybeSingle();
      if (b.error) throw b.error;
      if (b.data && b.data.revision !== a.data.revision) continue;   // saved while we were reading; read again
      return { nb: a.data, snap: { title: a.data.filename, cells: C.sortCells((c.data || []).map(C.cloneCell)) } };
    }
    throw new Error('The notebook keeps changing; please try again.');
  }

  /* ============================================================ state load */

  function initNewDraft() {
    S.nbId = null; S.ownerId = me(); S.revision = 0; S.seenRevision = 0;
    S.title = 'Untitled.ipynb';
    S.cells = [{ id: C.uuid(), cell_type: 'code', content: '', position: C.POS_STEP, last_edited_by: me(), updated_at: nowIso() }];
    S.base = { title: undefined, cells: [] };
    S.dirty = false; S.lastSavedAt = null;
    els.title.value = S.title;
    document.title = S.title + ' - Notebook';
    syncDom(); selectCell(S.cells[0].id); setStatus();
  }

  function applyServer(server, o) {
    o = o || {};
    var nb = server.nb;
    S.nbId = nb.id; S.ownerId = nb.owner_id; S.revision = nb.revision; S.seenRevision = Math.max(S.seenRevision, nb.revision);
    S.title = nb.filename;
    S.cells = server.snap.cells.map(C.cloneCell);
    if (!S.cells.length) S.cells = [{ id: C.uuid(), cell_type: 'code', content: '', position: C.POS_STEP, last_edited_by: me(), updated_at: nowIso() }];
    S.base = cloneSnap(server.snap);
    S.dirty = false; S.editVersion++;
    S.lastEditedBy = nb.last_edited_by; S.lastEditedAt = nb.updated_at;
    if (!o.initial) { S.lastSavedAt = S.lastSavedAt; }
    els.title.value = S.title;
    document.title = S.title + ' - Notebook';
    hideBanner('remote'); hideBanner('conflict'); S.pendingConflict = false; S.autosavePaused = false;
    syncDom();
    if (!S.selectedId || !getCell(S.selectedId)) selectCell(S.cells[0].id); else markSelected();
    writeDraftNow();
    setStatus();
  }

  function afterLoad() {
    window.addEventListener('keydown', onGlobalKey, true);
    window.addEventListener('beforeunload', function (e) {
      if (S.dirty && !S.skipUnload && !S.readOnly) { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden && S.dirty) save({ auto: true }); });
    window.addEventListener('online', function () { setStatus(); if (S.dirty) save({ auto: true }); });
    window.addEventListener('offline', setStatus);
    document.addEventListener('mousedown', function (e) {
      if (S.menu && !S.menu.pop.contains(e.target) && !e.target.closest('.menu-btn')) closeMenu();
    });
    setInterval(refreshBadges, 60000);
    setInterval(pollServer, cfg.POLL_MS || 30000);      // safety net: catches deletions and missed realtime events

    if (S.nbId) subscribeRealtime();
    loadProfile();
    if (S.masterMode) showMasterBanner();
    checkDraft();
  }

  async function loadProfile() {
    try {
      var r = await S.client.from('profiles').select('display_name').eq('id', S.user.id).maybeSingle();
      if (!r.error && r.data) S.profileName = r.data.display_name || '';
    } catch (e) { /* ignore */ }
    updateAvatar();
  }

  async function showMasterBanner() {
    var name = '';
    if (S.ownerId && S.ownerId !== me()) {
      try {
        var r = await S.client.from('profiles').select('display_name').eq('id', S.ownerId).maybeSingle();
        if (r.data && r.data.display_name) name = r.data.display_name;
      } catch (e) { /* ignore */ }
    }
    S.ownerName = name || ('Guest ' + NB.shortId(S.ownerId));
    showBanner('master', h('div', { class: 'banner info' },
      NB.icon('lock', 18),
      h('span', { class: 'grow', text: 'Master mode — you are editing ' + (S.ownerId === me() ? 'your own notebook' : S.ownerName + '’s notebook') + '. Your edits are marked on each cell.' }),
      h('a', { class: 'btn btn-text', href: 'master.html', text: 'Back to dashboard' })
    ));
  }

  /* ================================================================ banners */

  function showBanner(key, node) {
    hideBanner(key);
    node.dataset.bannerKey = key;
    els.banners.appendChild(node);
  }
  function hideBanner(key) {
    if (!els.banners) return;
    var old = els.banners.querySelector('[data-banner-key="' + key + '"]');
    if (old) old.remove();
  }

  /* ================================================================== save */

  function setStatus() {
    if (!els.status) return;
    var st, text, tip = '';
    var offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (S.readOnly) { st = 'readonly'; text = S.readOnlyReason || 'Read-only'; }
    else if (S.saving) { st = 'saving'; text = 'Saving…'; }
    else if (S.saveError) { st = (S.saveError.offline || offline) ? 'offline' : 'error'; text = st === 'offline' ? 'Offline — will retry' : 'Couldn’t save — Retry'; tip = S.saveError.message || ''; }
    else if (S.dirty && offline) { st = 'offline'; text = 'Offline — changes not saved'; }
    else if (S.dirty) { st = 'dirty'; text = 'Unsaved changes'; }
    else if (!S.nbId) { st = 'new'; text = 'Not saved yet — press Ctrl+S'; }
    else {
      st = 'saved'; text = 'All changes saved';
      var when = S.lastSavedAt || S.lastEditedAt;
      if (when) tip = 'Last saved ' + NB.absTime(when) + (S.lastEditedBy && S.lastEditedBy !== S.ownerId ? ' (last edit by master)' : '');
    }
    els.status.dataset.state = st;
    els.statusText.textContent = text;
    els.status.title = tip;
    els.status.setAttribute('aria-label', text);
  }

  function markDirty() {
    if (S.readOnly) return;
    S.dirty = true; S.editVersion++;
    setStatus();
    scheduleAutosave();
    scheduleDraft();
  }

  function scheduleAutosave() {
    clearTimeout(S.saveTimer);
    if (!cfg.AUTOSAVE_MS || S.autosavePaused || S.readOnly) return;
    S.saveTimer = setTimeout(function () { save({ auto: true }); }, cfg.AUTOSAVE_MS);
  }

  function draftKey() { return 'nb-draft:' + (me() || 'x') + ':' + (S.nbId || 'new'); }
  function scheduleDraft() { clearTimeout(S.draftTimer); S.draftTimer = setTimeout(writeDraftNow, 500); }
  function writeDraftNow() {
    try {
      var k = draftKey();
      if (!S.dirty) { localStorage.removeItem(k); return; }
      localStorage.setItem(k, JSON.stringify({
        v: 1, ts: Date.now(), baseRevision: S.revision, title: S.title,
        cells: S.cells.map(function (c) { return { id: c.id, cell_type: c.cell_type, content: c.content, position: c.position }; })
      }));
    } catch (e) { /* storage unavailable: fine */ }
  }
  function checkDraft() {
    try {
      var raw = localStorage.getItem(draftKey());
      if (!raw) return;
      var d = JSON.parse(raw);
      if (!d || d.v !== 1 || !Array.isArray(d.cells)) return;
      if (S.nbId && d.baseRevision !== S.revision) { localStorage.removeItem(draftKey()); return; }
      var same = d.title === S.title && d.cells.length === S.cells.length && d.cells.every(function (c) {
        var cur = getCell(c.id); return cur && cur.content === c.content && cur.cell_type === c.cell_type && cur.position === c.position;
      });
      if (same) { localStorage.removeItem(draftKey()); return; }
      showBanner('draft', h('div', { class: 'banner info' },
        NB.icon('info', 18),
        h('span', { class: 'grow', text: 'Recovered unsaved changes from ' + NB.relTime(d.ts) + '.' }),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Restore', on: { click: function () {
          S.title = C.normalizeTitle(d.title);
          S.cells = C.finalizeCells(d.cells.filter(function (c) { return c && C.isUuid(c.id) && (c.cell_type === 'code' || c.cell_type === 'text'); })
            .map(function (c) { var o = C.cloneCell(c); o.last_edited_by = me(); o.updated_at = nowIso(); o.content = String(c.content || '').slice(0, 100000); return o; }));
          if (!S.cells.length) S.cells = [{ id: C.uuid(), cell_type: 'code', content: '', position: C.POS_STEP, last_edited_by: me(), updated_at: nowIso() }];
          els.title.value = S.title; syncDom(); markDirty(); hideBanner('draft');
        } } }),
        h('button', { class: 'btn btn-text', type: 'button', text: 'Discard', on: { click: function () {
          try { localStorage.removeItem(draftKey()); } catch (e) { /* ignore */ }
          hideBanner('draft');
        } } })
      ));
    } catch (e) { /* ignore corrupt drafts */ }
  }

  async function ensureNotebook() {
    if (S.nbId) return;
    var r = await S.client.rpc('create_notebook', { p_filename: S.title });
    if (r.error) throw r.error;
    try { localStorage.removeItem(draftKey()); } catch (e) { /* ignore */ }
    S.nbId = r.data.id; S.ownerId = me(); S.revision = r.data.revision; S.seenRevision = r.data.revision;
    S.base = { title: S.title, cells: [] };
    try { history.replaceState(null, '', location.pathname + '?notebook_id=' + S.nbId + (S.masterMode ? '&mode=master' : '')); } catch (e) { /* ignore */ }
    subscribeRealtime();
  }

  async function save(opts) {
    opts = opts || {};
    if (S.readOnly) return;
    commitTitle();
    if (S.saving) { S.saveAgain = true; return; }
    if (!S.dirty && S.nbId) { if (opts.manual) NB.toast('All changes saved'); return; }
    if (!S.dirty && !S.nbId && !opts.manual) return;
    if (opts.manual) { S.autosavePaused = false; hideBanner('conflict'); }

    S.saving = true; S.saveError = null;
    clearTimeout(S.saveTimer); clearTimeout(S.retryTimer);
    setStatus();
    try {
      await ensureNotebook();
      var tries = 0;
      for (;;) {
        var snap = snapshot(), ver = S.editVersion;
        var r = await S.client.rpc('save_notebook', {
          p_notebook_id: S.nbId, p_expected_revision: S.revision, p_filename: snap.title,
          p_cells: snap.cells.map(function (c) { return { id: c.id, cell_type: c.cell_type, content: c.content, position: c.position }; })
        });
        if (r.error) throw r.error;
        if (r.data && r.data.status === 'ok') {
          S.revision = r.data.revision; S.seenRevision = Math.max(S.seenRevision, S.revision);
          S.base = cloneSnap(snap);
          S.lastSavedAt = new Date(); S.lastEditedBy = me();
          S.dirty = S.editVersion !== ver;
          S.retryCount = 0; S.saveError = null;
          if (opts.manual) NB.toast('Saved', { kind: 'ok', timeout: 1500 });
          writeDraftNow();
          break;
        }
        // revision mismatch: someone else saved first
        var resolved = await handleConflict(opts);
        if (!resolved) break;
        if (++tries >= 4) { S.saveError = { message: 'This notebook keeps changing. Try again in a moment.' }; break; }
      }
    } catch (e) {
      await handleSaveError(e, opts);
    } finally {
      S.saving = false;
      setStatus();
      if (S.dirty && !S.saveError && !S.readOnly && !S.autosavePaused) {
        if (S.saveAgain) { S.saveAgain = false; save({ auto: true }); } else scheduleAutosave();
      }
      S.saveAgain = false;
      if (S.seenRevision > S.revision && !S.readOnly) scheduleRefresh();
    }
  }

  async function handleSaveError(e, opts) {
    var code = e && e.code, msg = (e && (e.message || e.details)) || 'Unknown error';
    if (code === 'P0002') { lockNotebook('This notebook is no longer available.'); return; }
    if (code === '54000') { S.saveError = { message: 'Notebook limit reached (20). Delete one first.' }; NB.toast('You have reached the 20-notebook limit.', { kind: 'error' }); return; }
    var offline = NB.isNetworkError(e);
    if ((code === '28000' || e.status === 401 || /jwt/i.test(msg)) && !opts.retriedAuth) {
      try {
        var rr = await S.client.auth.refreshSession();
        if (!rr.error && rr.data && rr.data.session) { S.user = rr.data.session.user; S.saving = false; return save(Object.assign({}, opts, { retriedAuth: true })); }
      } catch (e2) { /* fall through */ }
      S.saveError = { message: 'Your session expired. Your changes are kept here — reload to sign in again.' };
      return;
    }
    S.saveError = { message: offline ? 'You appear to be offline.' : msg, offline: offline };
    S.retryCount++;
    if (S.retryCount <= 6) {
      var delay = Math.min(30000, 2000 * Math.pow(2, S.retryCount - 1));
      clearTimeout(S.retryTimer);
      S.retryTimer = setTimeout(function () { S.saveError = null; save({ auto: true }); }, delay);
    }
  }

  /* ----------------------------------------------------- conflict handling */

  async function handleConflict(opts) {
    var server = await fetchServer(S.nbId);
    if (!server) { lockNotebook('This notebook was deleted or is no longer available.'); return false; }
    var merged = C.mergeNotebooks(S.base, snapshot(), server.snap);

    if (merged.conflicts.length) {
      if (opts.auto) {
        // never interrupt typing with a dialog: park it behind a banner
        S.autosavePaused = true;
        showConflictBanner();
        return false;
      }
      var choices = await openConflictModal(merged.conflicts);
      if (!choices) { S.autosavePaused = true; showConflictBanner(); return false; }
      applyMerged(C.resolveConflicts(merged, choices), server);
      hideBanner('conflict'); S.autosavePaused = false;
      return true;
    }
    applyMerged({ title: merged.title, cells: merged.cells }, server);
    if (merged.serverChanged) NB.toast(S.masterMode ? 'Merged the latest changes from the owner' : 'Merged the latest changes from master');
    return true;
  }

  function applyMerged(fin, server) {
    S.revision = server.nb.revision; S.seenRevision = Math.max(S.seenRevision, S.revision);
    S.base = cloneSnap(server.snap);
    S.title = fin.title; S.cells = fin.cells.map(C.cloneCell);
    if (!S.cells.length) S.cells = [{ id: C.uuid(), cell_type: 'code', content: '', position: C.POS_STEP, last_edited_by: me(), updated_at: nowIso() }];
    els.title.value = S.title; document.title = S.title + ' - Notebook';
    S.dirty = true; S.editVersion++;
    syncDom(); markSelected();
  }

  function showConflictBanner() {
    showBanner('conflict', h('div', { class: 'banner' },
      NB.icon('warning', 18),
      h('span', { class: 'grow', text: 'Someone else changed cells you also edited. Autosave is paused until you choose which version to keep.' }),
      h('button', { class: 'btn btn-text', type: 'button', text: 'Resolve', on: { click: function () { save({ manual: true }); } } })
    ));
    setStatus();
  }

  function whoLabel(uid) {
    if (uid && uid === me()) return 'you';
    if (uid && uid === S.ownerId) return 'the owner';
    return uid ? 'master' : 'unknown';
  }

  function openConflictModal(conflicts) {
    return new Promise(function (resolve) {
      var choices = {}, groups = [];
      var list = h('div', {});
      conflicts.forEach(function (c, idx) {
        choices[c.id] = 'local';
        var name = 'cf' + idx;
        var isTitle = c.id === '__title__';
        var kindText = c.kind === 'title' ? 'Notebook name' : c.kind === 'deleted-on-server' ? 'Cell deleted elsewhere, edited here'
          : c.kind === 'deleted-locally' ? 'Cell deleted here, edited elsewhere' : 'Cell edited in both places';
        function colText(v) { return isTitle ? String(v) : (v ? v.content : '(deleted)'); }
        function col(side, label, v, caption) {
          var input = h('input', { type: 'radio', name: name, value: side });
          if (side === 'local') input.checked = true;
          input.addEventListener('change', function () { choices[c.id] = side; });
          groups.push({ input: input, side: side });
          return h('div', { class: 'conflict-col' + (v === null || v === undefined ? ' gone' : '') },
            h('label', {}, input, h('span', { text: label }), caption ? h('small', { text: ' · ' + caption }) : null),
            h('pre', { text: colText(v) || '(empty)' }));
        }
        list.appendChild(h('div', { class: 'conflict-item' },
          h('div', { class: 'conflict-head' }, h('span', { text: kindText })),
          h('div', { class: 'conflict-cols' },
            col('local', 'Keep mine', c.local),
            col('server', 'Use latest saved', c.server, isTitle ? '' : 'edited by ' + whoLabel(c.server && c.server.last_edited_by))
          )));
      });
      function bulk(side) { groups.forEach(function (g) { if (g.side === side) { g.input.checked = true; g.input.dispatchEvent(new Event('change')); } }); }
      var content = h('div', {},
        h('p', { class: 'modal-text', text: 'These items were changed both by you and by someone else since you last saved. Pick the version to keep for each one. Everything else was merged automatically.' }),
        h('div', { style: { display: 'flex', gap: '8px', margin: '12px 0' } },
          h('button', { class: 'btn btn-outline', type: 'button', text: 'Keep all mine', on: { click: function () { bulk('local'); } } }),
          h('button', { class: 'btn btn-outline', type: 'button', text: 'Use all latest saved', on: { click: function () { bulk('server'); } } })),
        list);
      var done = false;
      NB.openModal({
        title: 'Resolve conflicting changes', content: content, wide: true, dismissable: false,
        buttons: [
          { label: 'Decide later', kind: 'text', onClick: function (close) { done = true; resolve(null); close(); } },
          { label: 'Apply and save', kind: 'primary', onClick: function (close) { done = true; resolve(choices); close(); } }
        ],
        onClose: function () { if (!done) resolve(null); }
      });
    });
  }

  /* -------------------------------------------------------------- realtime */

  function subscribeRealtime() {
    if (!S.nbId || S.channel) return;
    try {
      var ch = S.client.channel('nb:' + S.nbId + ':' + Math.random().toString(36).slice(2, 8))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'notebooks', filter: 'id=eq.' + S.nbId }, onNotebookEvent)
        .subscribe(function (status) {
          var on = status === 'SUBSCRIBED';
          if (!on && (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED')) S.hadDisconnect = true;
          if (on && S.hadDisconnect) { S.hadDisconnect = false; scheduleRefresh(); }   // catch up on anything missed
          S.live = on; updateLive();
        });
      S.channel = ch;
    } catch (e) { /* realtime is a nice-to-have; saving still works */ }
  }

  function unsubscribeRealtime() {
    try { if (S.channel) S.client.removeChannel(S.channel); } catch (e) { /* ignore */ }
    S.channel = null; S.live = false; updateLive();
  }

  function updateLive() {
    if (!els.live) return;
    els.live.classList.toggle('on', S.live);
    els.live.textContent = S.live ? 'Live' : 'Offline';
    els.live.title = S.live ? 'Receiving live updates' : 'Not receiving live updates';
  }

  function onNotebookEvent(p) {
    var n = (p && p.new) || {};
    if ((p && p.eventType === 'DELETE') || n.deleted_at) { lockNotebook('This notebook was deleted.'); return; }
    if (typeof n.revision === 'number') {
      S.seenRevision = Math.max(S.seenRevision, n.revision);
      if (S.saving) return;                    // our own save is in flight; re-checked when it finishes
      if (n.revision <= S.revision) return;    // echo of our own save
    }
    scheduleRefresh();
  }

  async function pollServer() {
    if (!S.nbId || S.readOnly || S.saving || S.refreshing || document.hidden) return;
    try {
      var r = await S.client.from('notebooks').select('id, revision, deleted_at').eq('id', S.nbId).maybeSingle();
      if (r.error) return;
      if (!r.data || r.data.deleted_at) { lockNotebook('This notebook was deleted or is no longer available.'); return; }
      S.seenRevision = Math.max(S.seenRevision, r.data.revision);
      if (r.data.revision > S.revision) scheduleRefresh();
    } catch (e) { /* try again next tick */ }
  }

  function scheduleRefresh() {
    clearTimeout(S.refreshTimer);
    S.refreshTimer = setTimeout(refreshFromServer, 250);
  }

  async function refreshFromServer() {
    if (!S.nbId || S.readOnly) return;
    if (S.refreshing || S.saving) { S.refreshAgain = true; return; }
    S.refreshing = true;
    try {
      var server = await fetchServer(S.nbId);
      if (!server) { lockNotebook('This notebook was deleted or is no longer available.'); return; }
      if (server.nb.revision <= S.revision) return;
      var who = whoLabel(server.nb.last_edited_by);
      var text = who === 'master' ? 'Master updated this notebook' : who === 'the owner' ? 'The owner updated this notebook' : 'Updated from another tab or device';
      if (!S.dirty) {
        applyServer(server);
        NB.toast(text);
      } else {
        var merged = C.mergeNotebooks(S.base, snapshot(), server.snap);
        if (merged.conflicts.length) { S.autosavePaused = true; showConflictBanner(); }
        else { applyMerged({ title: merged.title, cells: merged.cells }, server); NB.toast(text + ' — merged with your edits'); }
      }
    } catch (e) { /* will retry on next event */ }
    finally {
      S.refreshing = false;
      if (S.refreshAgain) { S.refreshAgain = false; scheduleRefresh(); }
    }
  }

  function lockNotebook(reason) {
    S.readOnly = true; S.readOnlyReason = 'Read-only';
    clearTimeout(S.saveTimer); clearTimeout(S.retryTimer);
    unsubscribeRealtime();
    if (els.cellsRoot) els.cellsRoot.classList.add('readonly');
    if (els.title) els.title.readOnly = true;
    Array.prototype.forEach.call(document.querySelectorAll('.cell textarea'), function (t) { t.readOnly = true; });
    showBanner('locked', h('div', { class: 'banner danger' },
      NB.icon('lock', 18), h('span', { class: 'grow', text: reason }),
      h('a', { class: 'btn btn-text', href: S.masterMode ? 'master.html' : 'index.html?new=1', text: S.masterMode ? 'Back to dashboard' : 'New notebook' })));
    setStatus();
  }

  /* ================================================================ titles */

  function commitTitle() {
    if (!els.title) return;
    var t = C.normalizeTitle(els.title.value);
    var changed = t !== S.title;
    S.title = t; els.title.value = t; document.title = t + ' - Notebook';
    if (changed && !S.readOnly) markDirty();
  }
  function onTitleInput() { if (!S.readOnly && els.title.value !== S.title) markDirty(); }
  function onTitleKey(e) {
    if (e.key === 'Enter') { e.preventDefault(); commitTitle(); els.title.blur(); }
    else if (e.key === 'Escape') { els.title.value = S.title; els.title.blur(); }
  }

  /* ============================================================ cell model */

  function normalizeIfNeeded() { if (C.needsNormalize(S.cells)) S.cells = C.normalizePositions(S.cells); }

  function insertCell(type, index, o) {
    if (S.readOnly) return null;
    var cell = { id: C.uuid(), cell_type: type, content: '', position: C.positionFor(S.cells, index), last_edited_by: me(), updated_at: nowIso() };
    S.cells.splice(index, 0, cell);
    normalizeIfNeeded();
    syncDom(); markDirty();
    selectCell(cell.id, { focus: !o || o.focus !== false, scroll: true });
    return cell;
  }

  function insertAfter(afterId, type) {
    var idx = afterId ? indexOfCell(afterId) + 1 : 0;
    insertCell(type, idx);
  }

  function deleteCell(id) {
    if (S.readOnly) return;
    var idx = indexOfCell(id); if (idx < 0) return;
    var c = S.cells.splice(idx, 1)[0];
    S.deleted.push({ cell: c, index: idx }); if (S.deleted.length > 30) S.deleted.shift();
    delete S.outputs[id]; delete S.running[id];
    syncDom(); markDirty();
    var next = S.cells[Math.min(idx, S.cells.length - 1)];
    if (next) selectCell(next.id); else S.selectedId = null;
    NB.toast('Cell deleted', { action: { label: 'Undo', onClick: undoDelete } });
  }

  function undoDelete() {
    if (S.readOnly) return;
    var d = S.deleted.pop(); if (!d) { NB.toast('Nothing to undo'); return; }
    var idx = Math.min(d.index, S.cells.length);
    S.cells.splice(idx, 0, d.cell);
    S.cells = C.finalizeCells(S.cells);
    syncDom(); markDirty(); selectCell(d.cell.id, { scroll: true });
  }

  function moveCell(id, dir) {
    if (S.readOnly) return;
    var idx = indexOfCell(id), to = idx + dir;
    if (idx < 0 || to < 0 || to >= S.cells.length) return;
    var c = S.cells.splice(idx, 1)[0];
    c.position = C.positionFor(S.cells, to);
    c.last_edited_by = me(); c.updated_at = nowIso();
    S.cells.splice(to, 0, c);
    normalizeIfNeeded();
    syncDom(); markDirty(); selectCell(id, { scroll: true });
  }

  function duplicateCell(id) {
    var src = getCell(id); if (!src || S.readOnly) return;
    var idx = indexOfCell(id) + 1;
    var cell = { id: C.uuid(), cell_type: src.cell_type, content: src.content, position: C.positionFor(S.cells, idx), last_edited_by: me(), updated_at: nowIso() };
    S.cells.splice(idx, 0, cell); normalizeIfNeeded();
    syncDom(); markDirty(); selectCell(cell.id, { scroll: true });
  }

  function convertCell(id, type) {
    var c = getCell(id); if (!c || c.cell_type === type || S.readOnly) return;
    c.cell_type = type; c.last_edited_by = me(); c.updated_at = nowIso();
    delete S.outputs[id];
    syncDom(); markDirty(); selectCell(id);
  }

  /* ============================================================== DOM: cells */

  function insertRow(afterId) {
    return h('div', { class: 'insert-row', data: { after: afterId || '' } },
      h('button', { class: 'tool-btn', type: 'button', data: { insert: 'code' } }, NB.icon('add', 16), 'Code'),
      h('button', { class: 'tool-btn', type: 'button', data: { insert: 'text' } }, NB.icon('add', 16), 'Text'));
  }

  function cellToolbar() {
    function b(act, icon, label) {
      return h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, data: { act: act } }, NB.icon(icon, 18));
    }
    return h('div', { class: 'cell-toolbar', role: 'toolbar', 'aria-label': 'Cell actions' },
      b('up', 'up', 'Move cell up'), b('down', 'down', 'Move cell down'), b('copy', 'copy', 'Duplicate cell'), b('delete', 'delete', 'Delete cell'));
  }

  function createWrap(cell) {
    var isCode = cell.cell_type === 'code';
    var cellEl, body;
    var badge = h('div', { class: 'cell-badge' });
    if (isCode) {
      var code = h('code');
      var pre = h('pre', { 'aria-hidden': 'true' }, code);
      var ta = h('textarea', { class: 'code-input', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', 'aria-label': 'Code cell', rows: '1', maxlength: '100000' });
      var outputs = h('div', { class: 'outputs-wrap' });
      body = h('div', { class: 'cell-body' }, cellToolbar(), h('div', { class: 'code-editor' }, pre, ta), outputs, badge);
      cellEl = h('div', { class: 'cell code', tabindex: '-1', data: { id: cell.id } },
        h('div', { class: 'cell-gutter' },
          h('button', { class: 'run-btn', type: 'button', title: 'Run cell (Ctrl+Enter)', 'aria-label': 'Run cell', data: { act: 'run' } }, NB.icon('play', 22)),
          h('div', { class: 'exec-info' })),
        body);
    } else {
      var mta = h('textarea', { class: 'md-input', spellcheck: 'true', 'aria-label': 'Text cell (markdown)', rows: '3', maxlength: '100000' });
      var prev = h('div', { class: 'md-preview' });
      var view = h('div', { class: 'md-view', title: 'Double-click to edit' });
      body = h('div', { class: 'cell-body' }, cellToolbar(), view, h('div', { class: 'md-split' }, mta, prev), badge);
      cellEl = h('div', { class: 'cell text', tabindex: '-1', data: { id: cell.id } }, h('div', { class: 'cell-gutter' }), body);
    }
    var wrap = h('div', { class: 'cell-wrap', data: { id: cell.id, type: cell.cell_type } }, cellEl, insertRow(cell.id));
    return wrap;
  }

  function updateHighlight(wrap, value) {
    var code = wrap.querySelector('.code-editor code');
    code.innerHTML = C.highlightPython(value) + ((value === '' || value.slice(-1) === '\n') ? ' ' : '');
  }

  function autosizeMd(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.max(ta.scrollHeight + 2, 72) + 'px';
  }

  function badgeText(cell) {
    if (!cell.last_edited_by || !S.ownerId || cell.last_edited_by === S.ownerId) return '';
    return (cell.last_edited_by === me() ? 'Edited by you as master' : 'Edited by master') + (cell.updated_at ? ' · ' + NB.relTime(cell.updated_at) : '');
  }

  function refreshCellEl(wrap, cell) {
    var el = wrap.querySelector('.cell');
    var ta = el.querySelector('textarea');
    var focused = document.activeElement === ta;
    if (ta.value !== cell.content) {
      var pos = ta.selectionStart;
      ta.value = cell.content;
      if (focused) { try { var p = Math.min(pos, cell.content.length); ta.setSelectionRange(p, p); } catch (e) { /* ignore */ } }
      wrap._rendered = null;
    }
    ta.readOnly = S.readOnly;
    if (wrap._rendered !== cell.content) {
      if (cell.cell_type === 'code') updateHighlight(wrap, cell.content);
      else {
        var html = C.renderMarkdown(cell.content);
        el.querySelector('.md-view').innerHTML = html;
        el.querySelector('.md-preview').innerHTML = html;
        autosizeMd(ta);
      }
      wrap._rendered = cell.content;
    }
    var bt = badgeText(cell), badge = el.querySelector('.cell-badge');
    badge.textContent = bt; badge.classList.toggle('show', !!bt);
    renderOutputs(cell.id);
  }

  function syncDom() {
    var container = els.cells;
    var want = {};
    S.cells.forEach(function (c) { want[c.id] = true; });
    Array.prototype.slice.call(container.children).forEach(function (w) { if (!want[w.dataset.id]) w.remove(); });
    var prev = null;
    S.cells.forEach(function (cell) {
      var wrap = wrapOf(cell.id);
      if (wrap && wrap.dataset.type !== cell.cell_type) { wrap.remove(); wrap = null; }
      if (!wrap) wrap = createWrap(cell);
      var expected = prev ? prev.nextSibling : container.firstChild;
      if (wrap !== expected) container.insertBefore(wrap, expected);
      refreshCellEl(wrap, cell);
      prev = wrap;
    });
    els.empty.hidden = S.cells.length > 0;
    els.topInsert.hidden = S.cells.length === 0;
    if (S.panel) renderPanel();
  }

  function refreshBadges() {
    S.cells.forEach(function (c) {
      var w = wrapOf(c.id); if (!w) return;
      var bt = badgeText(c), badge = w.querySelector('.cell-badge');
      badge.textContent = bt; badge.classList.toggle('show', !!bt);
    });
  }

  /* ------------------------------------------------------------- selection */

  function markSelected() {
    Array.prototype.forEach.call(els.cells.querySelectorAll('.cell.selected'), function (e) { e.classList.remove('selected'); });
    var w = wrapOf(S.selectedId);
    if (w) w.querySelector('.cell').classList.add('selected');
  }

  function selectCell(id, o) {
    o = o || {};
    var prevId = S.selectedId;
    if (prevId && prevId !== id) { var pc = getCell(prevId); if (pc && pc.cell_type === 'text') stopEdit(prevId); }
    S.selectedId = id; markSelected();
    var w = wrapOf(id); if (!w) return;
    var el = w.querySelector('.cell');
    if (o.scroll) { try { w.scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ } }
    if (o.focus) {
      var cell = getCell(id);
      if (cell && cell.cell_type === 'text') startEdit(id); else el.querySelector('textarea').focus();
    } else if (o.focusCell) el.focus();
  }

  function startEdit(id) {
    if (S.readOnly) return;
    var w = wrapOf(id), c = getCell(id); if (!w || !c) return;
    if (c.cell_type === 'text') {
      var el = w.querySelector('.cell'); el.classList.add('editing');
      var ta = el.querySelector('textarea'); autosizeMd(ta); ta.focus();
    } else w.querySelector('textarea').focus();
  }

  function stopEdit(id) {
    var w = wrapOf(id), c = getCell(id); if (!w || !c) return;
    var el = w.querySelector('.cell');
    if (!el.classList.contains('editing')) return;
    el.classList.remove('editing');
    w._rendered = null; refreshCellEl(w, c);
  }

  /* ----------------------------------------------------------- cell events */

  function onNbClick(e) {
    var t = e.target;
    var ins = t.closest('[data-insert]');
    if (ins) { var row = ins.closest('.insert-row'); insertAfter(row.dataset.after, ins.dataset.insert); return; }
    var wrap = t.closest('.cell-wrap');
    var act = t.closest('[data-act]');
    if (act && wrap) {
      var id = wrap.dataset.id;
      selectCell(id);
      switch (act.dataset.act) {
        case 'run': runCell(id); break;
        case 'up': moveCell(id, -1); break;
        case 'down': moveCell(id, 1); break;
        case 'copy': duplicateCell(id); break;
        case 'delete': deleteCell(id); break;
        case 'clear': delete S.outputs[id]; renderOutputs(id); break;
      }
      return;
    }
    if (wrap) selectCell(wrap.dataset.id);
  }

  function onNbDblClick(e) {
    var view = e.target.closest('.md-view');
    if (view) { var w = view.closest('.cell-wrap'); selectCell(w.dataset.id); startEdit(w.dataset.id); }
  }

  function onCellsInput(e) {
    var ta = e.target; if (!ta.matches || !ta.matches('textarea')) return;
    var wrap = ta.closest('.cell-wrap'); if (!wrap) return;
    var cell = getCell(wrap.dataset.id); if (!cell || S.readOnly) return;
    cell.content = ta.value; cell.last_edited_by = me(); cell.updated_at = nowIso();
    wrap._rendered = cell.content;
    if (cell.cell_type === 'code') updateHighlight(wrap, cell.content);
    else {
      var html = C.renderMarkdown(cell.content);
      wrap.querySelector('.md-preview').innerHTML = html;
      wrap.querySelector('.md-view').innerHTML = html;
      autosizeMd(ta);
    }
    var bt = badgeText(cell), badge = wrap.querySelector('.cell-badge');
    badge.textContent = bt; badge.classList.toggle('show', !!bt);
    markDirty();
  }

  function onCellsFocusIn(e) {
    var wrap = e.target.closest && e.target.closest('.cell-wrap'); if (!wrap) return;
    var id = wrap.dataset.id;
    if (S.selectedId !== id) selectCell(id);
    if (e.target.matches && e.target.matches('textarea')) wrap.querySelector('.cell').classList.add('editing-mode');
  }

  function onCellsFocusOut(e) {
    var wrap = e.target.closest && e.target.closest('.cell-wrap'); if (!wrap) return;
    var el = wrap.querySelector('.cell');
    if (e.target.matches && e.target.matches('textarea')) el.classList.remove('editing-mode');
    var to = e.relatedTarget;
    if (el.classList.contains('editing') && !(to && el.contains(to))) stopEdit(wrap.dataset.id);
  }

  function insertText(ta, text) {
    var ok = false;
    try { ok = document.execCommand && document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  function replaceRange(ta, start, end, text, selStart, selEnd) {
    ta.setSelectionRange(start, end);
    var ok = false;
    try { ok = document.execCommand && document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    if (!ok) { ta.setRangeText(text, start, end, 'preserve'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
    ta.setSelectionRange(selStart, selEnd);
  }

  function lineBounds(ta) {
    var v = ta.value, s = ta.selectionStart, e = ta.selectionEnd;
    var start = v.lastIndexOf('\n', s - 1) + 1;
    var endIdx = v.indexOf('\n', e > s && v[e - 1] === '\n' ? e - 1 : e);
    return { start: start, end: endIdx === -1 ? v.length : endIdx };
  }

  function indentSelection(ta, outdent) {
    var s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    if (!outdent && s === e) { insertText(ta, '    '); return; }
    var b = lineBounds(ta), block = v.slice(b.start, b.end), lines = block.split('\n'), delta0 = 0, total = 0;
    var out = lines.map(function (l, i) {
      var nl;
      if (outdent) { var m = /^( {1,4}|\t)/.exec(l); nl = m ? l.slice(m[0].length) : l; }
      else nl = l.length ? '    ' + l : l;
      var d = nl.length - l.length; if (i === 0) delta0 = d; total += d; return nl;
    }).join('\n');
    replaceRange(ta, b.start, b.end, out, Math.max(b.start, s + delta0), e + total);
  }

  function toggleComment(ta) {
    var b = lineBounds(ta), v = ta.value, block = v.slice(b.start, b.end), lines = block.split('\n');
    var nonEmpty = lines.filter(function (l) { return l.trim() !== ''; });
    var allCommented = nonEmpty.length > 0 && nonEmpty.every(function (l) { return /^\s*#/.test(l); });
    var s = ta.selectionStart, e = ta.selectionEnd, delta0 = 0, total = 0;
    var out = lines.map(function (l, i) {
      var nl;
      if (allCommented) nl = l.replace(/^(\s*)# ?/, '$1');
      else nl = l.trim() === '' ? l : l.replace(/^(\s*)/, '$1# ');
      var d = nl.length - l.length; if (i === 0) delta0 = d; total += d; return nl;
    }).join('\n');
    replaceRange(ta, b.start, b.end, out, Math.max(b.start, s + delta0), Math.max(b.start, e + total));
  }

  function onCellKey(e) {
    var ta = e.target; if (!ta.matches || !ta.matches('textarea')) return;
    var wrap = ta.closest('.cell-wrap'); if (!wrap) return;
    var id = wrap.dataset.id, cell = getCell(id); if (!cell) return;
    var isCode = cell.cell_type === 'code', mod = e.ctrlKey || e.metaKey;

    if (e.key === 'Enter' && e.shiftKey && !mod) { e.preventDefault(); runAndAdvance(id); return; }
    if (e.key === 'Enter' && mod) { e.preventDefault(); if (isCode) runCell(id); else { stopEdit(id); focusCellEl(id); } return; }
    if (e.key === 'Enter' && e.altKey) { e.preventDefault(); if (isCode) runCell(id); insertCell('code', indexOfCell(id) + 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); if (!isCode) stopEdit(id); focusCellEl(id); return; }
    if (S.readOnly) return;
    if (isCode && e.key === 'Tab' && !mod && !e.altKey) { e.preventDefault(); indentSelection(ta, e.shiftKey); return; }
    if (isCode && e.key === '/' && mod) { e.preventDefault(); toggleComment(ta); return; }
    if (isCode && e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      var v = ta.value, before = v.slice(0, ta.selectionStart), line = before.slice(before.lastIndexOf('\n') + 1);
      var indent = /^[ \t]*/.exec(line)[0];
      if (/:\s*$/.test(line)) indent += '    ';
      insertText(ta, '\n' + indent);
    }
  }

  function focusCellEl(id) {
    var w = wrapOf(id); if (w) w.querySelector('.cell').focus();
  }

  /* ================================================================== runtime */

  function setRuntime(state) {
    S.runtime = state;
    if (els.connect) {
      els.connect.dataset.state = state;
      els.connectLabel.textContent = state === 'connected' ? '' : state === 'connecting' ? 'Connecting…' : 'Connect';
      els.resBars.hidden = state !== 'connected';
      els.spinner.hidden = state !== 'connecting';
      els.cloud.hidden = state === 'connecting';
    }
  }

  async function connectRuntime() {
    if (S.runtime === 'connected') return;
    if (S.runtime === 'connecting') { while (S.runtime === 'connecting') await sleep(50); return; }
    setRuntime('connecting');
    await sleep(700);
    setRuntime('connected');
  }

  function setRunning(id, on) {
    var w = wrapOf(id); if (!w) return;
    var el = w.querySelector('.cell'), btn = el.querySelector('.run-btn');
    el.classList.toggle('running', on);
    if (btn) {
      btn.replaceChildren(NB.icon(on ? 'stop' : 'play', 22));
      btn.title = on ? 'Interrupt execution' : 'Run cell (Ctrl+Enter)';
      btn.setAttribute('aria-label', on ? 'Interrupt execution' : 'Run cell');
    }
  }

  /* A cell counts as "from the master" when its last editor is not the notebook owner.
     Only a normal user page uses this; in master mode Run behaves as usual. */
  function isMasterEdited(cell) {
    return !S.masterMode && !!cell.last_edited_by && !!S.ownerId && cell.last_edited_by !== S.ownerId;
  }

  /* Copies the text exactly as it is (line breaks and indentation included) as plain text. */
  function copyText(text) {
    function legacy() {
      var prev = document.activeElement;
      var ta = h('textarea', { 'aria-hidden': 'true', tabindex: '-1', readonly: true, style: { position: 'fixed', top: '0', left: '-9999px', opacity: '0' } });
      ta.value = text;
      document.body.appendChild(ta);
      try { ta.focus({ preventScroll: true }); ta.select(); ta.setSelectionRange(0, text.length); document.execCommand('copy'); } catch (e) { /* ignore */ }
      ta.remove();
      if (prev && prev.focus) { try { prev.focus({ preventScroll: true }); } catch (e) { /* ignore */ } }
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(legacy);
        return;
      }
    } catch (e) { /* fall through to the older method */ }
    legacy();
  }

  async function runCell(id, skipCopy) {
    var cell = getCell(id);
    if (!cell || cell.cell_type !== 'code') return;
    if (S.running[id]) {                                   // clicking again interrupts
      delete S.running[id]; setRunning(id, false);
      S.outputs[id] = { outputs: [{ type: 'error', text: 'KeyboardInterrupt' }], ms: 0, interrupted: true };
      renderOutputs(id); return;
    }
    // Run on a cell the master edited also copies its text (must happen right here, inside the click).
    if (!skipCopy && isMasterEdited(cell) && cell.content) copyText(cell.content);
    S.stopAll = false;
    S.running[id] = true; setRunning(id, true);
    try { await connectRuntime(); } catch (e) { /* ignore */ }
    var t0 = Date.now();
    await sleep(180 + Math.random() * 240);
    if (!S.running[id]) return;                            // interrupted meanwhile
    var res = C.mockRun(cell.content, S.env);
    S.execCount++;
    S.outputs[id] = { outputs: res.outputs, ms: Date.now() - t0, count: S.execCount };
    delete S.running[id]; setRunning(id, false);
    renderOutputs(id);
  }

  function renderOutputs(id) {
    var w = wrapOf(id); if (!w) return;
    var box = w.querySelector('.outputs-wrap'), info = w.querySelector('.exec-info');
    if (!box) return;
    var o = S.outputs[id];
    box.textContent = '';
    if (info) info.textContent = '';
    if (!o) return;
    if (o.outputs.length) {
      box.appendChild(h('button', { class: 'icon-btn outputs-clear', type: 'button', title: 'Clear output', 'aria-label': 'Clear output', data: { act: 'clear' } }, NB.icon('close', 14)));
      o.outputs.forEach(function (x) { box.appendChild(h('pre', { class: 'out ' + x.type, text: x.text })); });
    }
    if (info && !o.interrupted) info.textContent = '✓ ' + (o.ms < 1000 ? o.ms + 'ms' : (o.ms / 1000).toFixed(1) + 's');
  }

  async function runAndAdvance(id) {
    var cell = getCell(id); if (!cell) return;
    var idx = indexOfCell(id);
    if (cell.cell_type === 'code') runCell(id); else stopEdit(id);
    var next = S.cells[idx + 1];
    if (next) selectCell(next.id, { focus: next.cell_type === 'code', focusCell: next.cell_type !== 'code', scroll: true });
    else insertCell('code', idx + 1, { focus: true });
  }

  async function runCells(list) {
    S.stopAll = false;
    for (var i = 0; i < list.length; i++) {
      if (S.stopAll) break;
      if (list[i].cell_type === 'code') {
        await runCell(list[i].id, true);                  // "Run all" never touches the clipboard
        while (S.running[list[i].id] && !S.stopAll) await sleep(40);
      }
    }
  }

  function interruptAll() {
    S.stopAll = true;
    Object.keys(S.running).forEach(function (id) {
      delete S.running[id]; setRunning(id, false);
      S.outputs[id] = { outputs: [{ type: 'error', text: 'KeyboardInterrupt' }], ms: 0, interrupted: true }; renderOutputs(id);
    });
  }

  function restartRuntime() {
    interruptAll(); S.env = {}; S.execCount = 0; S.outputs = {};
    S.cells.forEach(function (c) { renderOutputs(c.id); });
    if (S.panel === 'vars') renderPanel();
    NB.toast('Runtime restarted');
  }

  function disconnectRuntime() {
    interruptAll(); S.env = {}; S.execCount = 0; setRuntime('disconnected');
    if (S.panel === 'vars') renderPanel();
    NB.toast('Disconnected');
  }

  /* ================================================================== menus */

  function notAvailable(what) { NB.toast(what + ' isn’t available in this mock'); }

  function currentIndex() { var i = indexOfCell(S.selectedId); return i < 0 ? S.cells.length - 1 : i; }

  function menuDefs() {
    var sel = S.selectedId, idx = indexOfCell(sel), ro = S.readOnly;
    return {
      File: [
        { label: 'New notebook', disabled: S.masterMode, run: function () { go('index.html?new=1'); } },
        { label: 'Open notebook…', disabled: S.masterMode, run: openListModal },
        { sep: true },
        { label: 'Rename', run: function () { els.title.focus(); els.title.select(); }, disabled: ro },
        { label: 'Save', kbd: 'Ctrl+S', run: function () { save({ manual: true }); }, disabled: ro },
        { label: 'Download .ipynb', run: downloadIpynb },
        { sep: true },
        { label: 'Delete notebook…', disabled: ro || !S.nbId, run: deleteNotebook },
        S.masterMode ? { label: 'Back to dashboard', run: function () { go('master.html'); } } : null
      ].filter(Boolean),
      Edit: [
        { label: 'Undo delete cell', kbd: 'Ctrl+M Z', run: undoDelete, disabled: ro || !S.deleted.length },
        { sep: true },
        { label: 'Move cell up', kbd: 'Ctrl+M K', run: function () { moveCell(sel, -1); }, disabled: ro || idx <= 0 },
        { label: 'Move cell down', kbd: 'Ctrl+M J', run: function () { moveCell(sel, 1); }, disabled: ro || idx < 0 || idx >= S.cells.length - 1 },
        { label: 'Duplicate cell', run: function () { duplicateCell(sel); }, disabled: ro || idx < 0 },
        { label: 'Delete cell', kbd: 'Ctrl+M D', run: function () { deleteCell(sel); }, disabled: ro || idx < 0 },
        { sep: true },
        { label: 'Convert to code cell', kbd: 'Ctrl+M Y', run: function () { convertCell(sel, 'code'); }, disabled: ro || idx < 0 },
        { label: 'Convert to text cell', kbd: 'Ctrl+M M', run: function () { convertCell(sel, 'text'); }, disabled: ro || idx < 0 },
        { sep: true },
        { label: 'Clear all outputs', run: function () { S.outputs = {}; S.cells.forEach(function (c) { renderOutputs(c.id); }); } }
      ],
      View: [
        { label: 'Table of contents', run: function () { togglePanel('toc'); } },
        { label: 'Find in notebook', run: function () { togglePanel('find'); } },
        { label: 'Variables', run: function () { togglePanel('vars'); } },
        { sep: true },
        { label: NB.isDark() ? 'Switch to light theme' : 'Switch to dark theme', run: function () { NB.setTheme(NB.isDark() ? 'light' : 'dark'); } }
      ],
      Insert: [
        { label: 'Code cell', kbd: 'Ctrl+M B', run: function () { insertCell('code', currentIndex() + 1); }, disabled: ro },
        { label: 'Text cell', run: function () { insertCell('text', currentIndex() + 1); }, disabled: ro },
        { sep: true },
        { label: 'Code cell above', kbd: 'Ctrl+M A', run: function () { insertCell('code', Math.max(0, currentIndex())); }, disabled: ro }
      ],
      Runtime: [
        { label: 'Run all', kbd: 'Ctrl+F9', run: function () { runCells(S.cells.slice()); } },
        { label: 'Run before', run: function () { runCells(S.cells.slice(0, Math.max(0, idx))); }, disabled: idx <= 0 },
        { label: 'Run the focused cell', kbd: 'Ctrl+Enter', run: function () { runCell(sel); }, disabled: idx < 0 },
        { label: 'Run selection and after', run: function () { runCells(S.cells.slice(Math.max(0, idx))); }, disabled: idx < 0 },
        { sep: true },
        { label: 'Interrupt execution', kbd: 'Ctrl+M I', run: interruptAll },
        { label: 'Restart session', run: restartRuntime },
        { label: 'Disconnect and delete runtime', run: disconnectRuntime, disabled: S.runtime === 'disconnected' }
      ],
      Tools: [
        { label: 'Keyboard shortcuts', kbd: 'Ctrl+M H', run: showShortcuts },
        { label: 'Settings', run: function () { notAvailable('Settings'); } }
      ],
      Help: [
        { label: 'Keyboard shortcuts', run: showShortcuts },
        { label: 'About this notebook', run: showAbout }
      ]
    };
  }

  function openMenu(btn, name) {
    closeMenu();
    var items = menuDefs()[name]; if (!items) return;
    var pop = h('div', { class: 'menu-pop', role: 'menu' }, items.map(function (it) {
      if (it.sep) return h('div', { class: 'menu-sep', role: 'separator' });
      return h('button', {
        class: 'menu-item', type: 'button', role: 'menuitem', disabled: !!it.disabled,
        on: { click: function () { closeMenu(); it.run(); } }
      }, h('span', { text: it.label }), it.kbd ? h('span', { class: 'kbd', text: it.kbd }) : null);
    }));
    document.body.appendChild(pop);
    var r = btn.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = (r.bottom + 2) + 'px';
    btn.setAttribute('aria-expanded', 'true');
    S.menu = { pop: pop, btn: btn, name: name };
  }

  function closeMenu() {
    if (!S.menu) return;
    S.menu.btn.setAttribute('aria-expanded', 'false');
    S.menu.pop.remove(); S.menu = null;
  }

  function go(url) {
    var go2 = function () { S.skipUnload = true; location.href = url; };
    if (S.dirty && !S.readOnly) save({ auto: true }).then(function () { if (S.dirty) { NB.confirm('Leave without saving?', 'Some changes could not be saved.', { okLabel: 'Leave', danger: true }).then(function (ok) { if (ok) go2(); }); } else go2(); });
    else go2();
  }

  /* ============================================================ side panels */

  function togglePanel(name) {
    S.panel = S.panel === name ? null : name;
    els.panel.hidden = !S.panel;
    Array.prototype.forEach.call(els.rail.querySelectorAll('[data-panel]'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.panel === S.panel)); });
    if (S.panel) renderPanel();
  }

  function scrollToCell(id) {
    var w = wrapOf(id); if (!w) return;
    selectCell(id, { focusCell: true });
    w.scrollIntoView({ block: 'start' });
    if (window.matchMedia && window.matchMedia('(max-width: 760px)').matches) togglePanel(S.panel);
  }

  function renderPanel() {
    var titles = { toc: 'Table of contents', find: 'Find', vars: 'Variables', files: 'Files' };
    els.panelTitle.textContent = titles[S.panel] || '';
    var body = els.panelBody; body.textContent = '';
    if (S.panel === 'toc') {
      var hs = C.extractHeadings(S.cells);
      if (!hs.length) body.appendChild(h('div', { class: 'side-empty', text: 'No headings yet. Add a text cell that starts with # to build the outline.' }));
      hs.forEach(function (x) { body.appendChild(h('button', { class: 'toc-item l' + x.level, type: 'button', text: x.text, on: { click: function () { scrollToCell(x.cellId); } } })); });
    } else if (S.panel === 'vars') {
      var keys = Object.keys(S.env);
      if (!keys.length) body.appendChild(h('div', { class: 'side-empty', text: 'No variables yet. Run a cell such as  x = 5  to see it here.' }));
      keys.forEach(function (k) { body.appendChild(h('div', { class: 'var-row' }, h('b', { text: k }), h('span', { text: '= ' + (S.env[k].t === 's' ? '"' + S.env[k].v + '"' : String(S.env[k].v)) }))); });
    } else if (S.panel === 'find') {
      var results = h('div', {});
      var input = h('input', { class: 'input', type: 'search', placeholder: 'Find in notebook', 'aria-label': 'Find in notebook', value: S.findText || '' });
      function run() {
        S.findText = input.value; results.textContent = '';
        var q = input.value.trim().toLowerCase(); if (!q) return;
        var n = 0;
        S.cells.forEach(function (c) {
          var i = c.content.toLowerCase().indexOf(q); if (i < 0) return; n++;
          var line = c.content.slice(Math.max(0, c.content.lastIndexOf('\n', i) + 1)).split('\n')[0];
          results.appendChild(h('button', { class: 'find-hit', type: 'button', text: line.slice(0, 80), on: { click: function () { scrollToCell(c.id); } } }));
        });
        if (!n) results.appendChild(h('div', { class: 'side-empty', text: 'No matches' }));
      }
      input.addEventListener('input', run);
      body.appendChild(h('div', { class: 'find-box' }, input)); body.appendChild(results);
      if (S.findText) run();
    } else if (S.panel === 'files') {
      body.appendChild(h('div', { class: 'side-empty', text: 'Files aren’t available in this mock. Your notebook is stored in the database.' }));
    }
  }

  /* ================================================================ dialogs */

  function showShortcuts() {
    var rows = [
      ['Ctrl+S', 'Save notebook'], ['Ctrl+Enter', 'Run cell'], ['Shift+Enter', 'Run cell and select next'], ['Alt+Enter', 'Run cell and insert below'],
      ['Esc', 'Leave the editor (command mode)'], ['Enter', 'Edit the selected cell'], ['↑ / ↓', 'Select previous / next cell'],
      ['Ctrl+M B', 'Insert code cell below'], ['Ctrl+M A', 'Insert code cell above'], ['Ctrl+M D', 'Delete cell'], ['Ctrl+M Z', 'Undo cell deletion'],
      ['Ctrl+M Y', 'Change to code cell'], ['Ctrl+M M', 'Change to text cell'], ['Ctrl+M K / J', 'Move cell up / down'], ['Ctrl+M I', 'Interrupt execution'],
      ['Ctrl+/', 'Comment / uncomment lines'], ['Tab / Shift+Tab', 'Indent / outdent'], ['Double-click', 'Edit a text cell']
    ];
    NB.openModal({
      title: 'Keyboard shortcuts', wide: true,
      content: h('table', { class: 'shortcut-table' }, h('tbody', {}, rows.map(function (r) { return h('tr', {}, h('td', { text: r[0] }), h('td', { text: r[1] })); }))),
      buttons: [{ label: 'Close', kind: 'primary' }]
    });
  }

  function showAbout() {
    NB.openModal({
      title: 'About this notebook',
      content: h('div', {},
        h('p', { class: 'modal-text', text: 'A Colab-style notebook. Notebooks are saved to a shared database and a master can open and edit them.' }),
        h('p', { class: 'modal-text', text: 'Run is a mock: it simulates print(), variables and simple arithmetic only. Outputs are not saved. Real Python needs a separate sandboxed kernel.' })),
      buttons: [{ label: 'Close', kind: 'primary' }]
    });
  }

  async function openListModal() {
    var list = h('div', {}, h('div', { class: 'side-empty', text: 'Loading…' }));
    NB.openModal({ title: 'Open notebook', content: list, buttons: [{ label: 'Close', kind: 'text' }] });
    try {
      var r = await S.client.from('notebooks').select('id, filename, updated_at').eq('owner_id', S.user.id).is('deleted_at', null).order('updated_at', { ascending: false }).limit(50);
      if (r.error) throw r.error;
      list.textContent = '';
      if (!r.data.length) list.appendChild(h('div', { class: 'side-empty', text: 'You have no saved notebooks yet.' }));
      r.data.forEach(function (n) {
        list.appendChild(h('button', { class: 'nb-list-item', type: 'button', on: { click: function () { go('index.html?notebook_id=' + n.id); } } },
          h('span', { text: n.filename }), h('small', { text: NB.relTime(n.updated_at) })));
      });
    } catch (e) { list.textContent = ''; list.appendChild(h('div', { class: 'side-empty', text: 'Could not load your notebooks.' })); }
  }

  function downloadIpynb() {
    commitTitle();
    var json = JSON.stringify(C.toIpynb(S.title, S.cells), null, 1);
    var url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    var a = h('a', { href: url, download: S.title });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  async function deleteNotebook() {
    var ok = await NB.confirm('Delete this notebook?', '“' + S.title + '” will be removed' + (S.masterMode ? ' for its owner too' : '') + '.', { okLabel: 'Delete', danger: true });
    if (!ok) return;
    try {
      var r = await S.client.rpc('delete_notebook', { p_notebook_id: S.nbId });
      if (r.error) throw r.error;
      try { localStorage.removeItem(draftKey()); } catch (e) { /* ignore */ }
      S.skipUnload = true;
      location.href = S.masterMode ? 'master.html' : 'index.html?new=1';
    } catch (e) { NB.toast('Could not delete: ' + ((e && e.message) || 'error'), { kind: 'error' }); }
  }

  function updateAvatar() {
    if (!els.avatar) return;
    var label = S.masterMode ? 'M' : ((S.profileName || 'Guest').charAt(0).toUpperCase());
    els.avatar.textContent = label;
    els.avatar.classList.toggle('master', S.masterMode);
    els.avatar.title = (S.masterMode ? 'Master' : (S.profileName || 'Guest')) + ' — account';
  }

  function openProfile() {
    var input = h('input', { class: 'input', type: 'text', maxlength: '60', value: S.profileName, placeholder: 'e.g. Sreesanth', 'data-autofocus': '1' });
    var who = S.masterMode ? 'Signed in as master' + (S.user && S.user.email ? ' (' + S.user.email + ')' : '') : 'You are using a guest account. Your notebooks stay linked to this browser.';
    var buttons = [{ label: 'Cancel', kind: 'text' }];
    if (S.masterMode) buttons.unshift({ label: 'Sign out', kind: 'text', onClick: async function (close) { await S.client.auth.signOut(); S.skipUnload = true; location.href = 'master.html'; close(); } });
    buttons.push({
      label: 'Save', kind: 'primary', onClick: async function (close) {
        var name = input.value.trim().slice(0, 60);
        var r = await S.client.from('profiles').update({ display_name: name || null }).eq('id', S.user.id).select('display_name');
        if (r.error || !r.data || !r.data.length) { NB.toast('Could not save your name', { kind: 'error' }); return; }
        S.profileName = name; updateAvatar(); NB.toast('Name saved', { kind: 'ok' }); close();
      }
    });
    NB.openModal({
      title: 'Your profile',
      content: h('div', {}, h('p', { class: 'modal-text', text: who }), h('label', { class: 'field', style: { marginTop: '12px' } }, h('span', { text: 'Display name (shown to the master)' }), input)),
      buttons: buttons
    });
  }

  /* ================================================================ keyboard */

  function modalOpen() { return !!document.querySelector('.modal-backdrop'); }

  function startChord() {
    S.chord = true; clearTimeout(S.chordTimer);
    S.chordTimer = setTimeout(function () { S.chord = false; }, 2000);
  }

  function handleChord(e) {
    var k = (e.key || '').toLowerCase();
    if (k === 'control' || k === 'meta' || k === 'shift' || k === 'alt') return;
    S.chord = false; clearTimeout(S.chordTimer);
    e.preventDefault(); e.stopPropagation();
    var sel = S.selectedId, idx = indexOfCell(sel);
    switch (k) {
      case 'b': insertCell('code', idx < 0 ? S.cells.length : idx + 1); break;
      case 'a': insertCell('code', Math.max(0, idx)); break;
      case 'd': if (idx >= 0) deleteCell(sel); break;
      case 'z': undoDelete(); break;
      case 'y': if (idx >= 0) convertCell(sel, 'code'); break;
      case 'm': if (idx >= 0) convertCell(sel, 'text'); break;
      case 'k': if (idx >= 0) moveCell(sel, -1); break;
      case 'j': if (idx >= 0) moveCell(sel, 1); break;
      case 'i': interruptAll(); break;
      case 'h': showShortcuts(); break;
      case 's': save({ manual: true }); break;
    }
  }

  function onGlobalKey(e) {
    var mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && (e.key === 's' || e.key === 'S')) {
      e.preventDefault(); e.stopPropagation();
      if (!modalOpen()) { commitTitle(); save({ manual: true }); }
      return;
    }
    if (modalOpen()) return;
    if (S.chord) { handleChord(e); return; }
    if (mod && (e.key === 'm' || e.key === 'M') && !e.shiftKey) { e.preventDefault(); startChord(); return; }
    if (mod && e.key === 'F9') { e.preventDefault(); runCells(S.cells.slice()); return; }
    if (e.key === 'Escape' && S.menu) { closeMenu(); return; }
    // command mode: a cell itself (not its editor) has focus
    var a = document.activeElement;
    if (a && a.classList && a.classList.contains('cell') && !mod && !e.altKey) {
      var id = a.closest('.cell-wrap').dataset.id, idx = indexOfCell(id);
      if (e.key === 'ArrowDown' && idx < S.cells.length - 1) { e.preventDefault(); selectCell(S.cells[idx + 1].id, { focusCell: true, scroll: true }); }
      else if (e.key === 'ArrowUp' && idx > 0) { e.preventDefault(); selectCell(S.cells[idx - 1].id, { focusCell: true, scroll: true }); }
      else if (e.key === 'Enter') { e.preventDefault(); startEdit(id); }
    }
  }

  /* ================================================================= build UI */

  function buildUI() {
    root.textContent = '';
    els.title = h('input', {
      class: 'title-input', type: 'text', value: S.title, maxlength: '120', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Notebook name',
      on: { input: onTitleInput, blur: commitTitle, keydown: onTitleKey }
    });
    els.statusText = h('span', { text: '' });
    els.status = h('button', { class: 'save-status', type: 'button', 'aria-live': 'polite', on: { click: function () { if (S.saveError || (S.dirty && !S.saving)) save({ manual: true }); } } },
      h('span', { class: 'dot' }), els.statusText);
    els.live = h('span', { class: 'live-chip', text: 'Offline' });

    var menuNames = ['File', 'Edit', 'View', 'Insert', 'Runtime', 'Tools', 'Help'];
    els.menubar = h('nav', { class: 'menubar', 'aria-label': 'Menu' }, menuNames.map(function (n) {
      return h('button', {
        class: 'menu-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', text: n,
        on: {
          click: function (e) { if (S.menu && S.menu.name === n) closeMenu(); else openMenu(e.currentTarget, n); },
          mouseenter: function (e) { if (S.menu && S.menu.name !== n) openMenu(e.currentTarget, n); }
        }
      });
    }));

    els.avatar = h('button', { class: 'avatar', type: 'button', 'aria-label': 'Account', on: { click: openProfile } }, 'G');

    var header = h('header', { class: 'topbar' },
      h('div', { class: 'top-row' },
        h('a', { class: 'logo', href: 'index.html', title: 'Notebook home', 'aria-label': 'Notebook home', text: 'Co' }),
        h('div', { class: 'title-block' },
          h('div', { class: 'title-line' }, els.title,
            h('button', { class: 'icon-btn', type: 'button', title: 'Star (not available in this mock)', 'aria-label': 'Star', on: { click: function () { notAvailable('Starring'); } } }, NB.icon('star', 18))),
          h('div', { class: 'menu-row' }, els.menubar, els.live, els.status)),
        h('div', { class: 'top-actions' },
          NB.themeButton(),
          h('button', { class: 'btn share-btn', type: 'button', on: { click: function () { notAvailable('Sharing'); } } }, NB.icon('share', 18), 'Share'),
          els.avatar)));

    els.banners = h('div', { class: 'banners' });

    els.cloud = NB.icon('cloud', 18); els.cloud.classList.add('cloud');
    els.spinner = h('span', { class: 'spinner', hidden: true });
    els.connectLabel = h('span', { text: 'Connect' });
    els.resBars = h('span', { class: 'res-bars', hidden: true, 'aria-hidden': 'true' },
      h('span', { class: 'res-bar' }, h('i', { style: { width: '14%' } })), h('span', { class: 'res-bar disk' }, h('i', { style: { width: '27%' } })));
    els.connect = h('button', {
      class: 'connect-btn', type: 'button', 'data-state': 'disconnected', title: 'Connect to a (mock) runtime',
      on: { click: function () { if (S.runtime === 'disconnected') connectRuntime(); else showRuntimeMenu(); } }
    }, els.spinner, els.cloud, els.resBars, els.connectLabel);

    var toolbar = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Notebook toolbar' },
      h('button', { class: 'tool-btn', type: 'button', on: { click: function () { insertCell('code', currentIndex() + 1); } } }, NB.icon('add', 18), h('span', { text: 'Code' })),
      h('button', { class: 'tool-btn', type: 'button', on: { click: function () { insertCell('text', currentIndex() + 1); } } }, NB.icon('add', 18), h('span', { text: 'Text' })),
      h('span', { class: 'tool-sep' }),
      h('button', { class: 'tool-btn', type: 'button', title: 'Run all cells (Ctrl+F9)', on: { click: function () { runCells(S.cells.slice()); } } }, NB.icon('play', 18), h('span', { class: 'label-long', text: 'Run all' })),
      h('span', { class: 'spacer' }), els.connect);

    function railBtn(name, icon, label) {
      return h('button', { class: 'icon-btn', type: 'button', title: label, 'aria-label': label, 'aria-pressed': 'false', data: { panel: name }, on: { click: function () { togglePanel(name); } } }, NB.icon(icon, 22));
    }
    els.rail = h('div', { class: 'rail', role: 'toolbar', 'aria-label': 'Side panels' },
      railBtn('toc', 'list', 'Table of contents'), railBtn('find', 'search', 'Find'), railBtn('vars', 'code', 'Variables'), railBtn('files', 'folder', 'Files'));

    els.panelTitle = h('span');
    els.panelBody = h('div', { class: 'side-body' });
    els.panel = h('aside', { class: 'side-panel', hidden: true },
      h('div', { class: 'side-head' }, els.panelTitle, h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close panel', on: { click: function () { togglePanel(S.panel); } } }, NB.icon('close', 18))),
      els.panelBody);

    els.topInsert = h('div', { class: 'insert-row', data: { after: '' } },
      h('button', { class: 'tool-btn', type: 'button', data: { insert: 'code' } }, NB.icon('add', 16), 'Code'),
      h('button', { class: 'tool-btn', type: 'button', data: { insert: 'text' } }, NB.icon('add', 16), 'Text'));
    els.cells = h('div', { id: 'cells' });
    els.empty = h('div', { class: 'empty-state', hidden: true },
      h('div', { text: 'This notebook is empty.' }),
      h('div', { class: 'row' },
        h('button', { class: 'tool-btn', type: 'button', data: { insert: 'code' } }, NB.icon('add', 16), 'Code'),
        h('button', { class: 'tool-btn', type: 'button', data: { insert: 'text' } }, NB.icon('add', 16), 'Text')));
    els.empty.dataset.after = '';
    els.cellsRoot = h('div', { class: 'nb-inner' }, els.topInsert, els.cells, els.empty);
    els.notebook = h('main', { class: 'notebook' }, els.cellsRoot);

    // empty-state buttons live outside any .insert-row, so give them an explicit parent hook
    els.empty.addEventListener('click', function (e) {
      var b = e.target.closest('[data-insert]'); if (b) { e.stopPropagation(); insertCell(b.dataset.insert, 0); }
    });

    els.cellsRoot.addEventListener('click', onNbClick);
    els.cellsRoot.addEventListener('dblclick', onNbDblClick);
    els.cells.addEventListener('input', onCellsInput);
    els.cells.addEventListener('keydown', onCellKey);
    els.cells.addEventListener('focusin', onCellsFocusIn);
    els.cells.addEventListener('focusout', onCellsFocusOut);

    root.appendChild(header);
    root.appendChild(els.banners);
    root.appendChild(toolbar);
    root.appendChild(h('div', { class: 'workspace' }, els.rail, els.panel, els.notebook));

    setRuntime('disconnected'); updateLive(); updateAvatar();
  }

  function showRuntimeMenu() {
    closeMenu();
    var pop = h('div', { class: 'menu-pop', role: 'menu' },
      h('button', { class: 'menu-item', type: 'button', onclick: null, on: { click: function () { closeMenu(); restartRuntime(); } } }, h('span', { text: 'Restart session' })),
      h('button', { class: 'menu-item', type: 'button', on: { click: function () { closeMenu(); disconnectRuntime(); } } }, h('span', { text: 'Disconnect and delete runtime' })),
      h('div', { class: 'menu-sep' }),
      h('div', { class: 'side-empty', text: 'Mock runtime · RAM 1.8 / 12.7 GB · Disk 29 / 107 GB' }));
    document.body.appendChild(pop);
    var r = els.connect.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.right - pop.offsetWidth, window.innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = (r.bottom + 2) + 'px';
    S.menu = { pop: pop, btn: els.connect, name: '__runtime' };
  }

  // test hook (harmless in production)
  window.__nb = { S: S, els: els, save: save, runCell: runCell, refreshFromServer: refreshFromServer, insertCell: insertCell };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
