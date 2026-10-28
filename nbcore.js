/*
 * nbcore.js — pure helpers (no DOM, no network).
 * Works in the browser (window.NBCore) and in Node (module.exports) so it can be unit-tested.
 *
 * Contents: ids/titles, cell ordering, 3-way merge, safe markdown, python highlighter,
 *           mock python runtime, .ipynb export.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NBCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var POS_STEP = 1000;

  /* ------------------------------------------------------------------ basics */

  function uuid() {
    var c = (typeof crypto !== 'undefined') ? crypto : null;
    if (c && c.randomUUID) return c.randomUUID();
    var b = new Uint8Array(16), i;
    if (c && c.getRandomValues) c.getRandomValues(b);
    else for (i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function isUuid(s) {
    return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** "Sreesanth" -> "Sreesanth.ipynb"; strips path chars; max 120 chars (DB limit). */
  function normalizeTitle(raw) {
    var t = String(raw == null ? '' : raw).replace(/[\\\/\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
    var base = t.replace(/\.ipynb$/i, '').trim();
    if (!base) return 'Untitled.ipynb';
    if (base.length > 114) base = base.slice(0, 114).trim();
    return base + '.ipynb';
  }

  /* ------------------------------------------------------------------- cells */

  function sameCell(a, b) {
    if (!a || !b) return !a && !b;
    return a.cell_type === b.cell_type && a.content === b.content && a.position === b.position;
  }

  function cloneCell(c) {
    return {
      id: c.id, cell_type: c.cell_type, content: c.content, position: c.position,
      last_edited_by: c.last_edited_by || null, updated_at: c.updated_at || null
    };
  }

  function sortCells(cells) {
    return cells.slice().sort(function (a, b) {
      return (a.position - b.position) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
  }

  function needsNormalize(sorted) {
    for (var i = 1; i < sorted.length; i++) {
      if (!(sorted[i].position - sorted[i - 1].position > 1e-6)) return true;
    }
    return false;
  }

  function normalizePositions(sorted) {
    return sorted.map(function (c, i) { var n = cloneCell(c); n.position = (i + 1) * POS_STEP; return n; });
  }

  /** Position for a cell inserted at `index` of the (sorted) array `cells`. */
  function positionFor(cells, index) {
    var prev = index > 0 ? cells[index - 1].position : null;
    var next = index < cells.length ? cells[index].position : null;
    if (prev === null && next === null) return POS_STEP;
    if (prev === null) return next - POS_STEP;
    if (next === null) return prev + POS_STEP;
    return (prev + next) / 2;
  }

  function finalizeCells(cells) {
    var sorted = sortCells(cells);
    return needsNormalize(sorted) ? normalizePositions(sorted) : sorted;
  }

  /* ------------------------------------------------------------ 3-way merge */
  /*
   * base   = last snapshot known to match the server
   * local  = what the user has in the editor
   * server = what the server has now
   * Each is {title, cells:[{id,cell_type,content,position,...}]}.
   *
   * Per cell: if only one side changed it, take that side; if both changed it
   * differently, it's a conflict the user must resolve.
   */
  function toMap(arr) { var m = {}; (arr || []).forEach(function (c) { m[c.id] = c; }); return m; }

  function mergeNotebooks(base, local, server) {
    base = base || { title: undefined, cells: [] };
    var B = toMap(base.cells), L = toMap(local.cells), S = toMap(server.cells);
    var ids = [], seen = {};
    [server.cells, local.cells].forEach(function (arr) {
      arr.forEach(function (c) { if (!seen[c.id]) { seen[c.id] = 1; ids.push(c.id); } });
    });

    var cells = [], conflicts = [], serverChanged = false;

    ids.forEach(function (id) {
      var b = B[id], l = L[id], s = S[id], pick;
      if (sameCell(l, s)) pick = s;
      else if (sameCell(l, b)) pick = s;           // only the server changed it
      else if (sameCell(s, b)) pick = l;           // only I changed it
      else {
        conflicts.push({
          id: id, kind: !l ? 'deleted-locally' : !s ? 'deleted-on-server' : 'both-edited',
          local: l ? cloneCell(l) : null, server: s ? cloneCell(s) : null
        });
        serverChanged = true;
        return;
      }
      if (!sameCell(pick, l)) serverChanged = true;
      if (pick) cells.push(cloneCell(pick));
    });

    var title, lt = local.title, st = server.title, bt = base.title;
    if (lt === st) title = lt;
    else if (lt === bt) { title = st; serverChanged = true; }
    else if (st === bt) title = lt;
    else {
      title = lt; serverChanged = true;
      conflicts.push({ id: '__title__', kind: 'title', local: lt, server: st });
    }

    return { title: title, cells: finalizeCells(cells), conflicts: conflicts, serverChanged: serverChanged };
  }

  /** choices: { [conflictId]: 'local' | 'server' }  (default 'local') */
  function resolveConflicts(merged, choices) {
    var cells = merged.cells.slice(), title = merged.title;
    merged.conflicts.forEach(function (c) {
      var side = choices && choices[c.id] === 'server' ? 'server' : 'local';
      var pick = side === 'server' ? c.server : c.local;
      if (c.id === '__title__') title = pick;
      else if (pick) cells.push(cloneCell(pick));
    });
    return { title: title, cells: finalizeCells(cells) };
  }

  /* ------------------------------------------------------ safe markdown -> HTML */
  /*
   * Everything is HTML-escaped FIRST, then a small set of markdown constructs is
   * turned into a fixed set of tags. Raw HTML in a text cell can never execute.
   * Links are limited to http(s) and mailto.
   */
  function inlineMd(text) {
    var stash = [];
    function keep(html) { stash.push(html); return '\u0000' + (stash.length - 1) + '\u0000'; }
    var s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, function (m, c) { return keep('<code>' + c + '</code>'); });
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, label, url) {
      var raw = url.replace(/&amp;/g, '&');
      if (!/^(https?:\/\/|mailto:)/i.test(raw)) return m;
      return keep('<a href="' + url + '" target="_blank" rel="noopener noreferrer nofollow">' + label + '</a>');
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^_\w])__([^_\n]+)__(?![_\w])/g, '$1<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_(?![_\w])/g, '$1<em>$2</em>');
    s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    s = s.replace(/\u0000(\d+)\u0000/g, function (m, i) { return stash[+i]; });
    return s;
  }

  function renderMarkdown(src) {
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');
    var out = [], i = 0, m;

    function isBlockStart(line) {
      return /^```/.test(line) || /^#{1,6}\s/.test(line) || /^>\s?/.test(line) ||
        /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(line);
    }

    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }

      if (/^```/.test(line)) {
        var code = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) { code.push(lines[i]); i++; }
        i++;
        out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
      } else if ((m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
        out.push('<h' + m[1].length + '>' + inlineMd(m[2]) + '</h' + m[1].length + '>'); i++;
      } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        out.push('<hr>'); i++;
      } else if (/^>\s?/.test(line)) {
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i])) { q.push(lines[i].replace(/^>\s?/, '')); i++; }
        out.push('<blockquote>' + inlineMd(q.join('\n')) + '</blockquote>');
      } else if (/^\s*[-*+]\s+/.test(line)) {
        var ul = [];
        while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { ul.push('<li>' + inlineMd(lines[i].replace(/^\s*[-*+]\s+/, '')) + '</li>'); i++; }
        out.push('<ul>' + ul.join('') + '</ul>');
      } else if (/^\s*\d+[.)]\s+/.test(line)) {
        var ol = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) { ol.push('<li>' + inlineMd(lines[i].replace(/^\s*\d+[.)]\s+/, '')) + '</li>'); i++; }
        out.push('<ol>' + ol.join('') + '</ol>');
      } else {
        var p = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) && (p.length === 0 || !isBlockStart(lines[i]))) { p.push(lines[i]); i++; }
        out.push('<p>' + inlineMd(p.join('\n')) + '</p>');
      }
    }
    return out.join('\n');
  }

  /** Headings of text cells, in order: [{level, text, cellId}] */
  function extractHeadings(cells) {
    var res = [];
    sortCells(cells).forEach(function (c) {
      if (c.cell_type !== 'text') return;
      String(c.content).split('\n').forEach(function (line) {
        var m = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (m && m[2]) res.push({ level: m[1].length, text: m[2], cellId: c.id });
      });
    });
    return res;
  }

  /* -------------------------------------------------------- python highlighter */

  var PY_KW = {};
  ('False None True and as assert async await break class continue def del elif else except finally for from ' +
   'global if import in is lambda nonlocal not or pass raise return try while with yield').split(' ')
    .forEach(function (k) { PY_KW[k] = 1; });
  var PY_BUILTIN = {};
  ('print len range int float str list dict set tuple bool type input open sum min max abs round sorted enumerate zip map ' +
   'filter isinstance super self cls any all reversed id hash repr format iter next').split(' ')
    .forEach(function (k) { PY_BUILTIN[k] = 1; });

  function highlightPython(src) {
    src = String(src == null ? '' : src);
    var re = /("""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|[rbfRBF]{0,2}"(?:\\.|[^"\\\n])*(?:"|$)|[rbfRBF]{0,2}'(?:\\.|[^'\\\n])*(?:'|$))|(#[^\n]*)|(\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(@[A-Za-z_][\w.]*)|([A-Za-z_]\w*)/gm;
    var out = '', last = 0, m, prevKw = '';
    while ((m = re.exec(src))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out += escapeHtml(src.slice(last, m.index));
      var tok = escapeHtml(m[0]);
      if (m[1] !== undefined) out += '<span class="tk-str">' + tok + '</span>';
      else if (m[2] !== undefined) out += '<span class="tk-com">' + tok + '</span>';
      else if (m[3] !== undefined) out += '<span class="tk-num">' + tok + '</span>';
      else if (m[4] !== undefined) out += '<span class="tk-dec">' + tok + '</span>';
      else {
        var w = m[5];
        if (prevKw === 'def' || prevKw === 'class') { out += '<span class="tk-def">' + tok + '</span>'; prevKw = ''; }
        else if (PY_KW[w]) { out += '<span class="tk-kw">' + tok + '</span>'; prevKw = w; }
        else if (PY_BUILTIN[w]) { out += '<span class="tk-bi">' + tok + '</span>'; prevKw = ''; }
        else { out += tok; prevKw = ''; }
      }
      last = m.index + m[0].length;
    }
    return out + escapeHtml(src.slice(last));
  }

  /* ------------------------------------------------------- mock python runtime */
  /*
   * NOT a real Python. Simulates: print(...), variables, + - * / // % **, strings,
   * f-strings with {expr}, and a bare final expression. Anything else prints a note.
   * Real execution needs a separate sandboxed kernel (see README).
   */
  function PyErr(name, msg) { var e = new Error(msg); e.py = name; return e; }
  function Unsup() { var e = new Error('unsupported'); e.unsupported = true; return e; }

  function unescapePy(s) {
    return s.replace(/\\(.)/g, function (m, c) {
      return c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : c === '"' ? '"' : c === "'" ? "'" : m;
    });
  }

  function tokenize(s) {
    var re = /\s*(?:(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|(?![fF]["'])([A-Za-z_]\w*)|(\*\*|\/\/|[-+*\/%()])|([fF]"(?:\\.|[^"\\])*"|[fF]'(?:\\.|[^'\\])*')|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'))/g;
    var toks = [], m, pos = 0;
    s = String(s);
    while (pos < s.length && /\S/.test(s.slice(pos))) {
      re.lastIndex = pos;
      m = re.exec(s);
      if (!m || m.index !== pos) throw Unsup();
      pos = re.lastIndex;
      if (m[1] !== undefined) toks.push({ k: 'num', v: parseFloat(m[1]), f: /[.eE]/.test(m[1]) });
      else if (m[2] !== undefined) toks.push({ k: 'id', v: m[2] });
      else if (m[3] !== undefined) toks.push({ k: 'op', v: m[3] });
      else if (m[4] !== undefined) toks.push({ k: 'fstr', v: m[4].slice(2, -1) });
      else toks.push({ k: 'str', v: unescapePy(m[5].slice(1, -1)) });
    }
    return toks;
  }

  function pyType(v) { return v.t === 's' ? 'str' : v.f ? 'float' : 'int'; }

  function binop(op, a, b) {
    var f = (a.f || b.f) ? true : false, r;
    if (op === '+') {
      if (a.t === 's' && b.t === 's') return { t: 's', v: a.v + b.v };
      if (a.t === 'n' && b.t === 'n') return { t: 'n', v: a.v + b.v, f: f };
      throw PyErr('TypeError', a.t === 's' ? 'can only concatenate str (not "' + pyType(b) + '") to str'
        : "unsupported operand type(s) for +: '" + pyType(a) + "' and '" + pyType(b) + "'");
    }
    if (op === '*') {
      if (a.t === 'n' && b.t === 'n') return { t: 'n', v: a.v * b.v, f: f };
      if (a.t === 's' && b.t === 'n' && !b.f) return { t: 's', v: b.v > 0 ? new Array(Math.min(b.v, 10000) + 1).join(a.v) : '' };
      if (a.t === 'n' && !a.f && b.t === 's') return { t: 's', v: a.v > 0 ? new Array(Math.min(a.v, 10000) + 1).join(b.v) : '' };
      throw PyErr('TypeError', "can't multiply sequence by non-int of type 'float'");
    }
    if (a.t !== 'n' || b.t !== 'n') throw PyErr('TypeError', "unsupported operand type(s) for " + op + ": '" + pyType(a) + "' and '" + pyType(b) + "'");
    if (op === '-') return { t: 'n', v: a.v - b.v, f: f };
    if (op === '/') { if (b.v === 0) throw PyErr('ZeroDivisionError', 'division by zero'); return { t: 'n', v: a.v / b.v, f: true }; }
    if (op === '//') { if (b.v === 0) throw PyErr('ZeroDivisionError', 'integer division or modulo by zero'); return { t: 'n', v: Math.floor(a.v / b.v), f: f }; }
    if (op === '%') { if (b.v === 0) throw PyErr('ZeroDivisionError', 'integer modulo by zero'); r = ((a.v % b.v) + b.v) % b.v; return { t: 'n', v: r, f: f }; }
    if (op === '**') {
      r = Math.pow(a.v, b.v);
      if (!isFinite(r)) throw PyErr('OverflowError', 'result too large');
      return { t: 'n', v: r, f: f || b.v < 0 };
    }
    throw Unsup();
  }

  function fmtVal(v) {
    if (v.t === 's') return v.v;
    if (v.f) return (Number.isInteger(v.v) && Math.abs(v.v) < 1e16) ? v.v.toFixed(1) : String(v.v);
    return String(v.v);
  }
  function reprVal(v) { return v.t === 's' ? "'" + v.v.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n') + "'" : fmtVal(v); }

  function evalExpr(s, env) {
    var toks = tokenize(s), p = 0;
    function peek() { return toks[p]; }
    function isOp(v) { var t = peek(); return !!t && t.k === 'op' && t.v === v; }
    function expr() {
      var l = term();
      while (isOp('+') || isOp('-')) { var op = toks[p++].v; l = binop(op, l, term()); }
      return l;
    }
    function term() {
      var l = unary();
      while (isOp('*') || isOp('/') || isOp('//') || isOp('%')) { var op = toks[p++].v; l = binop(op, l, unary()); }
      return l;
    }
    function unary() {
      if (isOp('-')) { p++; var v = unary(); if (v.t !== 'n') throw PyErr('TypeError', "bad operand type for unary -: 'str'"); return { t: 'n', v: -v.v, f: v.f }; }
      if (isOp('+')) { p++; return unary(); }
      return power();
    }
    function power() {
      var b = primary();
      if (isOp('**')) { p++; return binop('**', b, unary()); }
      return b;
    }
    function primary() {
      var t = toks[p++];
      if (!t) throw Unsup();
      if (t.k === 'num') return { t: 'n', v: t.v, f: t.f };
      if (t.k === 'str') return { t: 's', v: t.v };
      if (t.k === 'fstr') {
        return { t: 's', v: unescapePy(t.v).replace(/\{([^{}]+)\}/g, function (m, e) { return fmtVal(evalExpr(e, env)); }) };
      }
      if (t.k === 'id') {
        if (Object.prototype.hasOwnProperty.call(env, t.v)) return env[t.v];
        if (PY_KW[t.v]) throw Unsup();
        throw PyErr('NameError', "name '" + t.v + "' is not defined");
      }
      if (t.k === 'op' && t.v === '(') {
        var v = expr();
        if (!isOp(')')) throw Unsup();
        p++; return v;
      }
      throw Unsup();
    }
    var v = expr();
    if (p !== toks.length) throw Unsup();
    return v;
  }

  function splitArgs(s) {
    var args = [], depth = 0, q = '', cur = '';
    for (var i = 0; i < s.length; i++) {
      var ch = s[i];
      if (q) { cur += ch; if (ch === '\\') { cur += s[++i] || ''; } else if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") { q = ch; cur += ch; continue; }
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === ',' && depth === 0) { args.push(cur.trim()); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim() !== '' || args.length) args.push(cur.trim());
    return args;
  }

  var MOCK_NOTE = 'Mock runtime: only print(), variables and simple arithmetic are simulated here. ' +
                  'Connect a real Python kernel to run everything else.';

  /** env is mutated (kernel state). Returns {outputs:[{type:'stream'|'result'|'error'|'info', text}]} */
  function mockRun(src, env) {
    env = env || {};
    var stdout = [], lastExpr = null, unsupported = false, m;
    var lines = String(src == null ? '' : src).replace(/\r\n?/g, '\n').split('\n');

    function finish(extra) {
      var outputs = [];
      if (stdout.length) outputs.push({ type: 'stream', text: stdout.join('\n') });
      if (extra) outputs.push(extra);
      return { outputs: outputs };
    }

    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (!t || t.charAt(0) === '#') continue;
      lastExpr = null;
      try {
        if ((m = /^print\((.*)\)$/.exec(t))) {
          stdout.push(splitArgs(m[1]).map(function (a) { return fmtVal(evalExpr(a, env)); }).join(' '));
        } else if ((m = /^([A-Za-z_]\w*)\s*(\*\*|\/\/|[-+*\/%])?=\s*(.+)$/.exec(t)) && m[3].charAt(0) !== '=') {
          var val = evalExpr(m[3], env);
          if (m[2]) {
            if (!Object.prototype.hasOwnProperty.call(env, m[1])) throw PyErr('NameError', "name '" + m[1] + "' is not defined");
            val = binop(m[2], env[m[1]], val);
          }
          env[m[1]] = val;
        } else if (/^(import|from)\s/.test(t)) {
          /* ignored in the mock */
        } else {
          lastExpr = evalExpr(t, env);
        }
      } catch (e) {
        // after an unsupported line, state may be incomplete, so don't report misleading errors
        if (e.py && !unsupported) return finish({ type: 'error', text: e.py + ': ' + e.message });
        unsupported = true;
        lastExpr = null;
      }
    }
    var res = lastExpr ? { type: 'result', text: reprVal(lastExpr) } : null;
    var outs = finish(res).outputs;
    if (unsupported) outs.push({ type: 'info', text: MOCK_NOTE });
    return { outputs: outs };
  }

  /* ------------------------------------------------------------------ export */

  function splitSource(content) {
    if (!content) return [];
    var parts = String(content).split('\n');
    return parts.map(function (l, i) { return i < parts.length - 1 ? l + '\n' : l; });
  }

  function toIpynb(title, cells) {
    return {
      cells: sortCells(cells).map(function (c) {
        return c.cell_type === 'code'
          ? { cell_type: 'code', execution_count: null, id: c.id, metadata: {}, outputs: [], source: splitSource(c.content) }
          : { cell_type: 'markdown', id: c.id, metadata: {}, source: splitSource(c.content) };
      }),
      metadata: {
        colab: { name: title },
        kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
        language_info: { name: 'python' }
      },
      nbformat: 4,
      nbformat_minor: 5
    };
  }

  return {
    POS_STEP: POS_STEP, uuid: uuid, isUuid: isUuid, escapeHtml: escapeHtml, normalizeTitle: normalizeTitle,
    sameCell: sameCell, cloneCell: cloneCell, sortCells: sortCells, needsNormalize: needsNormalize,
    normalizePositions: normalizePositions, positionFor: positionFor, finalizeCells: finalizeCells,
    mergeNotebooks: mergeNotebooks, resolveConflicts: resolveConflicts,
    renderMarkdown: renderMarkdown, extractHeadings: extractHeadings,
    highlightPython: highlightPython, mockRun: mockRun, toIpynb: toIpynb
  };
});
