/*
 * common.js — small helpers shared by index.html and master.html
 * (Supabase client, tiny DOM builder, icons, toasts, modals, time formatting).
 */
(function () {
  'use strict';

  var cfg = window.NB_CONFIG || {};
  var NB = { cfg: cfg };

  // Two storage keys so a master login never replaces a visitor's anonymous session
  // (they can coexist in one browser).
  NB.KEY_USER = 'nb-auth-user';
  NB.KEY_MASTER = 'nb-auth-master';

  /* ------------------------------------------------------------- supabase */

  NB.configured = function () {
    return /^https:\/\/[^/\s]+/.test(cfg.SUPABASE_URL || '') &&
      !!cfg.SUPABASE_KEY && !/YOUR_/i.test(cfg.SUPABASE_KEY);
  };

  NB.libLoaded = function () {
    return !!(window.supabase && window.supabase.createClient);
  };

  NB.createClient = function (storageKey) {
    return window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY, {
      auth: {
        storageKey: storageKey,
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false
      },
      realtime: { params: { eventsPerSecond: 5 } }
    });
  };

  /** Is this user a master? RLS only lets a user see their OWN row of master_users. */
  NB.checkMaster = async function (client, uid) {
    var r = await client.from('master_users').select('user_id').eq('user_id', uid).maybeSingle();
    if (r.error) throw r.error;
    return !!r.data;
  };

  NB.isNetworkError = function (e) {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return true;
    var m = String((e && (e.message || e.name)) || e || '');
    return /failed to fetch|networkerror|network request failed|load failed|timeout|ECONN|offline/i.test(m);
  };

  /* ------------------------------------------------------------------ DOM */

  NB.h = function (tag, attrs) {
    var el = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === undefined || v === null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.keys(v).forEach(function (p) { el.style[p] = v[p]; });
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (k === 'data') Object.keys(v).forEach(function (d) { el.dataset[d] = v[d]; });
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    });
    for (var i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  };

  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) child.forEach(function (c) { append(el, c); });
    else if (child instanceof Node) el.appendChild(child);
    else el.appendChild(document.createTextNode(String(child)));
  }

  var ICONS = {
    play: 'M8 5v14l11-7z',
    stop: 'M6 6h12v12H6z',
    add: 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z',
    delete: 'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
    up: 'M4 12l1.41 1.41L11 7.83V20h2V7.83l5.58 5.59L20 12l-8-8-8 8z',
    down: 'M20 12l-1.41-1.41L13 16.17V4h-2v12.17l-5.58-5.59L4 12l8 8 8-8z',
    copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
    close: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    check: 'M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
    menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
    search: 'M15.5 14h-.79l-.28-.27A6.471 6.471 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
    expand: 'M16.59 8.59L12 13.17 7.41 8.59 6 10l6 6 6-6z',
    list: 'M3 9h14V7H3v2zm0 4h14v-2H3v2zm0 4h14v-2H3v2zm16 0h2v-2h-2v2zm0-10v2h2V7h-2zm0 6h2v-2h-2v2z',
    folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
    code: 'M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z',
    cloud: 'M19.35 10.04A7.49 7.49 0 0 0 12 4C9.11 4 6.6 5.64 5.35 8.04A5.994 5.994 0 0 0 0 14c0 3.31 2.69 6 6 6h13c2.76 0 5-2.24 5-5 0-2.64-2.05-4.78-4.65-4.96z',
    share: 'M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92 1.61 0 2.92-1.31 2.92-2.92s-1.31-2.92-2.92-2.92z',
    star: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24z',
    lock: 'M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z',
    warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    back: 'M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.41-1.41L7.83 13H20v-2z',
    undo: 'M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    info: 'M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    logout: 'M17 7l-1.41 1.41L18.17 11H8v2h10.17l-2.58 2.58L17 17l5-5zM4 5h8V3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h8v-2H4V5z',
    sort: 'M3 18h6v-2H3v2zM3 6v2h18V6H3zm0 7h12v-2H3v2z',
    eye: 'M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z',
    sun: 'M6.76 4.84l-1.8-1.79-1.41 1.41 1.79 1.79 1.42-1.41zM4 10.5H1v2h3v-2zm9-9.95h-2V3.5h2V.55zm7.45 3.91l-1.41-1.41-1.79 1.79 1.41 1.41 1.79-1.79zm-3.21 13.7l1.79 1.8 1.41-1.41-1.8-1.79-1.4 1.4zM20 10.5v2h3v-2h-3zm-8-5c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6zm-1 16.95h2V19.5h-2v2.95zm-7.45-3.91l1.41 1.41 1.79-1.8-1.41-1.41-1.79 1.8z',
    moon: 'M12 3a9 9 0 1 0 9 9c0-.46-.04-.92-.1-1.36a5.389 5.389 0 0 1-4.4 2.26 5.403 5.403 0 0 1-3.14-9.8c-.44-.06-.9-.1-1.36-.1z',
    chevronLeft: 'M15.41 7.41L14 6l-6 6 6 6 1.41-1.41L10.83 12z',
    chevronRight: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z'
  };
  NB.ICON_NAMES = Object.keys(ICONS);

  NB.icon = function (name, size) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(size || 20));
    svg.setAttribute('height', String(size || 20));
    svg.setAttribute('fill', 'currentColor');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.info);
    svg.appendChild(p);
    return svg;
  };

  /* ---------------------------------------------------------------- toast */

  NB.toast = function (message, opts) {
    opts = opts || {};
    var wrap = document.getElementById('toasts');
    if (!wrap) { wrap = NB.h('div', { id: 'toasts', 'aria-live': 'polite' }); document.body.appendChild(wrap); }
    var el = NB.h('div', { class: 'toast' + (opts.kind ? ' ' + opts.kind : ''), role: 'status' }, NB.h('span', { text: message }));
    var timer;
    function close() { clearTimeout(timer); if (el.parentNode) el.parentNode.removeChild(el); }
    if (opts.action) {
      el.appendChild(NB.h('button', {
        class: 'toast-action', type: 'button', text: opts.action.label,
        on: { click: function () { close(); opts.action.onClick(); } }
      }));
    }
    wrap.appendChild(el);
    timer = setTimeout(close, opts.timeout || (opts.action ? 8000 : 3500));
    return { close: close };
  };

  /* ---------------------------------------------------------------- modal */

  /**
   * NB.openModal({title, content, buttons:[{label, kind, onClick(close)}], dismissable, wide})
   * kind: 'primary' | 'danger' | 'text'
   */
  NB.openModal = function (o) {
    var previouslyFocused = document.activeElement;
    var backdrop = NB.h('div', { class: 'modal-backdrop' });
    var modal = NB.h('div', { class: 'modal' + (o.wide ? ' wide' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Dialog' });
    var closed = false;

    function close() {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      if (previouslyFocused && previouslyFocused.focus) { try { previouslyFocused.focus(); } catch (e) { /* ignore */ } }
      if (o.onClose) o.onClose();
    }
    function onKey(e) {
      if (e.key === 'Escape' && o.dismissable !== false) { e.stopPropagation(); close(); }
      if (e.key === 'Tab') {
        var f = modal.querySelectorAll('button, input, select, textarea, a[href]');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    }

    if (o.title) {
      var head = NB.h('div', { class: 'modal-head' }, NB.h('h2', { text: o.title }));
      if (o.dismissable !== false) {
        head.appendChild(NB.h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', on: { click: close } }, NB.icon('close')));
      }
      modal.appendChild(head);
    }
    modal.appendChild(NB.h('div', { class: 'modal-body' }, o.content));
    if (o.buttons && o.buttons.length) {
      modal.appendChild(NB.h('div', { class: 'modal-foot' }, o.buttons.map(function (b) {
        return NB.h('button', {
          type: 'button', class: 'btn ' + (b.kind === 'primary' ? 'btn-primary' : b.kind === 'danger' ? 'btn-danger' : 'btn-text'),
          text: b.label, on: { click: function () { if (b.onClick) b.onClick(close); else close(); } }
        });
      })));
    }
    backdrop.appendChild(modal);
    if (o.dismissable !== false) {
      backdrop.addEventListener('mousedown', function (e) { if (e.target === backdrop) close(); });
    }
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKey, true);
    var focusTarget = modal.querySelector('[data-autofocus]') || modal.querySelector('.modal-foot .btn-primary, .modal-foot .btn-danger, .modal-foot .btn') || modal.querySelector('button, input');
    if (focusTarget) focusTarget.focus();
    return { close: close, el: modal };
  };

  /** Promise<boolean> */
  NB.confirm = function (title, message, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (!done) { done = true; resolve(v); } }
      NB.openModal({
        title: title,
        content: NB.h('p', { class: 'modal-text', text: message }),
        onClose: function () { fin(false); },
        buttons: [
          { label: opts.cancelLabel || 'Cancel', kind: 'text', onClick: function (close) { fin(false); close(); } },
          { label: opts.okLabel || 'OK', kind: opts.danger ? 'danger' : 'primary', onClick: function (close) { fin(true); close(); } }
        ]
      });
    });
  };

  /* ----------------------------------------------------------------- time */

  function toDate(v) { return v instanceof Date ? v : new Date(v); }

  NB.relTime = function (v, now) {
    if (!v) return '—';
    var d = toDate(v), diff = Math.round(((now || Date.now()) - d.getTime()) / 1000);
    if (isNaN(diff)) return '—';
    if (diff < 10) return 'just now';
    if (diff < 60) return diff + ' sec ago';
    if (diff < 3600) return Math.floor(diff / 60) + ' min ago';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h ago';
    if (diff < 172800) return 'yesterday';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + ' days ago';
    return NB.absTime(d, true);
  };

  NB.absTime = function (v, dateOnly) {
    if (!v) return '';
    var d = toDate(v);
    if (isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat(undefined, dateOnly ? { dateStyle: 'medium' } : { dateStyle: 'medium', timeStyle: 'short' }).format(d);
    } catch (e) { return d.toLocaleString(); }
  };

  NB.clockTime = function (v) {
    var d = toDate(v || new Date());
    try { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d); }
    catch (e) { return d.toLocaleTimeString(); }
  };

  NB.shortId = function (id) { return String(id || '').replace(/-/g, '').slice(0, 6); };

  /* ---------------------------------------------------------------- theme */

  NB.getTheme = function () {
    try { return localStorage.getItem('nb-theme') || ''; } catch (e) { return ''; }
  };
  NB.setTheme = function (t) {
    try { if (t) localStorage.setItem('nb-theme', t); else localStorage.removeItem('nb-theme'); } catch (e) { /* ignore */ }
    NB.applyTheme();
  };
  NB.applyTheme = function () {
    var t = NB.getTheme();
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    try { window.dispatchEvent(new Event('nb-theme')); } catch (e) { /* ignore */ }
  };
  NB.isDark = function () {
    var t = NB.getTheme();
    if (t) return t === 'dark';
    return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  };
  NB.applyTheme();

  /** A visible dark/light toggle. Shows the icon of the theme you will switch TO. */
  NB.themeButton = function () {
    var btn = NB.h('button', { class: 'icon-btn theme-toggle', type: 'button' });
    function paint() {
      var dark = NB.isDark();
      btn.replaceChildren(NB.icon(dark ? 'sun' : 'moon', 22));
      var label = dark ? 'Switch to light theme' : 'Switch to dark theme';
      btn.title = label; btn.setAttribute('aria-label', label); btn.setAttribute('aria-pressed', String(dark));
      var m = document.querySelector('meta[name="theme-color"]');
      if (m) m.setAttribute('content', dark ? '#232426' : '#ffffff');
    }
    btn.addEventListener('click', function () { NB.setTheme(NB.isDark() ? 'light' : 'dark'); });
    window.addEventListener('nb-theme', paint);
    if (window.matchMedia) {
      var mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) mq.addEventListener('change', paint);
    }
    paint();
    return btn;
  };

  /* ---------------------------------------------------------- fatal screen */

  /** Replaces the page body content with a friendly full-page message. */
  NB.showFatal = function (root, o) {
    root.textContent = '';
    var box = NB.h('div', { class: 'fatal' },
      NB.h('div', { class: 'fatal-icon' }, NB.icon(o.icon || 'warning', 36)),
      NB.h('h1', { text: o.title }),
      NB.h('p', { text: o.message }),
      o.details ? NB.h('pre', { class: 'fatal-details', text: o.details }) : null,
      NB.h('div', { class: 'fatal-actions' }, (o.actions || []).map(function (a) {
        return a.href
          ? NB.h('a', { class: 'btn ' + (a.primary ? 'btn-primary' : 'btn-text'), href: a.href, text: a.label })
          : NB.h('button', { type: 'button', class: 'btn ' + (a.primary ? 'btn-primary' : 'btn-text'), text: a.label, on: { click: a.onClick } });
      }))
    );
    root.appendChild(box);
  };

  /** Shared guard for both pages; returns true when it is safe to continue. */
  NB.preflight = function (root) {
    if (!NB.libLoaded()) {
      NB.showFatal(root, {
        title: 'Could not load Supabase',
        message: 'The Supabase library did not load. Check your internet connection or any content blocker, then reload.',
        actions: [{ label: 'Reload', primary: true, onClick: function () { location.reload(); } }]
      });
      return false;
    }
    if (!NB.configured()) {
      NB.showFatal(root, {
        icon: 'info',
        title: 'Almost there — add your Supabase key',
        message: 'Open config.js and paste your project URL and publishable (anon) key from Supabase → Connect. Then commit and reload this page.',
        actions: []
      });
      return false;
    }
    return true;
  };

  window.NB = NB;
})();
