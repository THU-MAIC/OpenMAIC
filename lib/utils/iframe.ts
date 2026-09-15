import { injectIntoDocumentHead } from './html-document';

/**
 * In-memory localStorage/sessionStorage shim, injected as the FIRST thing in the
 * document so the page's own scripts see working storage.
 *
 * The interactive iframe is sandboxed `allow-scripts` WITHOUT `allow-same-origin`
 * (intentional — combining them negates the sandbox for LLM-authored HTML). In a
 * null-origin document, touching `window.localStorage` throws a SecurityError;
 * many generated pages read/write storage in their setup code, so that throw
 * crashes the script before anything renders → a blank/black widget. This shim
 * replaces both storages with an in-memory implementation when the real ones are
 * inaccessible, keeping the sandbox intact while letting storage-using pages run.
 */
const STORAGE_SHIM = `<script data-iframe-storage-shim>
(function () {
  function makeStore() {
    var data = Object.create(null);
    return {
      getItem: function (k) { k = String(k); return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[String(k)] = String(v); },
      removeItem: function (k) { delete data[String(k)]; },
      clear: function () { data = Object.create(null); },
      key: function (i) { var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
      get length() { return Object.keys(data).length; }
    };
  }
  ['localStorage', 'sessionStorage'].forEach(function (name) {
    var ok = false;
    try { var s = window[name]; if (s) { s.getItem('__probe__'); ok = true; } } catch (e) { ok = false; }
    if (!ok) {
      try { Object.defineProperty(window, name, { value: makeStore(), configurable: true }); } catch (e) {}
    }
  });
})();
</script>`;

/**
 * Runtime-error capture, injected as the VERY FIRST script so it observes errors
 * from the storage shim and every page script that follows. Generated interactive
 * pages frequently die on a runtime error (a `JSON.parse` of malformed config, a
 * reference to a CDN lib that failed to load, …) → the script aborts and the
 * widget renders blank. The sandboxed (null-origin) iframe can't be read by the
 * editor, but it CAN `postMessage` out: this forwards `window.onerror`, unhandled
 * rejections and `console.error` to the parent, which stores them per scene and
 * feeds them to the editor agent — so it can diagnose a blank page instead of
 * guessing. Only touches `window.*` so it stays sandbox-safe and unit-testable.
 *
 * The most important errors (a `JSON.parse` that aborts setup) fire SYNCHRONOUSLY
 * while srcDoc parses — potentially before the parent has subscribed its `message`
 * listener (which it installs from a passive effect after inserting the iframe).
 * To avoid losing exactly the errors this feature exists to surface, every post is
 * also buffered, and the shim re-emits the whole buffer when the parent sends a
 * `{ __maicErrorReplayRequest: true }` message once its listener is ready. The
 * parent dedups, so the live + replayed copies collapse to one.
 */
const ERROR_CAPTURE_SHIM = `<script data-iframe-error-shim>
(function () {
  var buffer = [];
  function emit(errorKind, message) {
    try {
      window.parent.postMessage(
        { __maicInteractive: true, kind: 'runtime-error', errorKind: errorKind, message: message },
        '*'
      );
    } catch (e) {}
  }
  function post(errorKind, message) {
    message = String(message).slice(0, 1200);
    if (buffer.length < 50) buffer.push([errorKind, message]);
    emit(errorKind, message);
  }
  window.addEventListener('message', function (e) {
    var d = e && e.data;
    if (d && d.__maicErrorReplayRequest === true) {
      for (var i = 0; i < buffer.length; i++) emit(buffer[i][0], buffer[i][1]);
    }
  });
  window.addEventListener('error', function (e) {
    if (e && e.message) {
      post('error', e.message + (e.filename ? ' (' + e.filename + ':' + (e.lineno || 0) + ')' : ''));
    } else if (e && e.target && (e.target.src || e.target.href)) {
      post('resource', 'Failed to load resource: ' + (e.target.src || e.target.href));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    post('unhandledrejection', (r && (r.stack || r.message)) || r || 'unhandled promise rejection');
  });
  try {
    var c = window.console;
    if (c && c.error) {
      var _ce = c.error;
      c.error = function () {
        try { post('console.error', Array.prototype.map.call(arguments, function (a) { return (a && a.stack) || String(a); }).join(' ')); } catch (e) {}
        return _ce.apply(c, arguments);
      };
    }
  } catch (e) {}
})();
</script>`;

/** Dormant-by-default picker installed into generated interactive documents. */
const ELEMENT_PICKER_SHIM = `<script data-iframe-element-picker-shim>
(function () {
  if (window.__maicElementPickerInstalled) return;
  window.__maicElementPickerInstalled = true;
  var armed = false;
  var selectors = [];
  var root = null;
  var hoverBox = null;
  var candidate = null;
  var raf = null;
  function emit(message) {
    try { window.parent.postMessage(message, '*'); } catch (e) {}
  }
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
    return String(value).replace(/[^a-zA-Z0-9_-]/g, function (char) { return '\\\\' + char; });
  }
  function unique(selector) {
    try { return document.querySelectorAll(selector).length === 1; } catch (e) { return false; }
  }
  function selectorFor(element) {
    if (element.id) {
      var byId = '#' + cssEscape(element.id);
      if (unique(byId)) return byId;
    }
    var tag = element.tagName.toLowerCase();
    if (element.classList && element.classList.length) {
      var classes = Array.prototype.slice.call(element.classList, 0, 3).map(cssEscape);
      if (classes.length) {
        var byClass = tag + '.' + classes.join('.');
        if (unique(byClass)) return byClass;
      }
    }
    var parts = [];
    var node = element;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      var nodeTag = node.tagName.toLowerCase();
      var parent = node.parentElement;
      if (!parent) break;
      var sameTag = Array.prototype.filter.call(parent.children, function (child) {
        return child.tagName === node.tagName;
      });
      var part = nodeTag;
      if (sameTag.length > 1) part += ':nth-of-type(' + (sameTag.indexOf(node) + 1) + ')';
      parts.unshift(part);
      var path = parts.join(' > ');
      if (unique(path)) return path;
      node = parent;
    }
    return parts.join(' > ') || tag;
  }
  function ensureRoot() {
    if (root && root.isConnected) return;
    root = document.createElement('div');
    root.setAttribute('data-maic-element-picker-overlay', '');
    root.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:2147483647;';
    hoverBox = document.createElement('div');
    hoverBox.style.cssText = 'display:none;position:absolute;border:2px solid #7c3aed;background:rgba(124,58,237,.10);box-sizing:border-box;border-radius:3px;pointer-events:none;';
    root.appendChild(hoverBox);
    (document.body || document.documentElement).appendChild(root);
  }
  function position(node, element) {
    var rect = element.getBoundingClientRect();
    node.style.left = (rect.left + window.scrollX) + 'px';
    node.style.top = (rect.top + window.scrollY) + 'px';
    node.style.width = rect.width + 'px';
    node.style.height = rect.height + 'px';
  }
  function isOverlay(element) {
    return !!(element && element.closest && element.closest('[data-maic-element-picker-overlay]'));
  }
  function selectable(element) {
    return !!element && element !== document.documentElement && element !== document.body && !isOverlay(element);
  }
  function draw() {
    raf = null;
    if (!armed) return;
    ensureRoot();
    if (candidate && candidate.isConnected) {
      position(hoverBox, candidate);
      hoverBox.style.display = 'block';
    } else {
      hoverBox.style.display = 'none';
    }
    Array.prototype.slice.call(root.querySelectorAll('[data-maic-picker-pin]')).forEach(function (node) { node.remove(); });
    selectors.forEach(function (selector, index) {
      var element = null;
      try { element = document.querySelector(selector); } catch (e) {}
      if (!selectable(element)) return;
      var badge = document.createElement('div');
      badge.setAttribute('data-maic-picker-pin', '');
      badge.textContent = String(index + 1);
      badge.style.cssText = 'position:absolute;display:grid;place-items:center;width:20px;height:20px;border-radius:999px;background:#7c3aed;color:white;border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,.35);font:700 11px/1 system-ui,sans-serif;box-sizing:border-box;pointer-events:none;';
      var rect = element.getBoundingClientRect();
      badge.style.left = Math.max(0, rect.left + window.scrollX - 8) + 'px';
      badge.style.top = Math.max(0, rect.top + window.scrollY - 8) + 'px';
      root.appendChild(badge);
    });
  }
  function scheduleDraw() {
    if (raf == null) raf = window.requestAnimationFrame(draw);
  }
  function onPointerMove(event) {
    var element = document.elementFromPoint(event.clientX, event.clientY);
    candidate = selectable(element) ? element : null;
    scheduleDraw();
  }
  function block(event) {
    if (!armed) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  function onClick(event) {
    if (!armed) return;
    block(event);
    var element = document.elementFromPoint(event.clientX, event.clientY);
    if (!selectable(element)) return;
    candidate = element;
    emit({
      __maicInteractive: true,
      kind: 'element-picked',
      selector: selectorFor(element),
      outerHTML: String(element.outerHTML || '').slice(0, 2048),
      text: String(typeof element.innerText === 'string' ? element.innerText : '').slice(0, 200)
    });
    scheduleDraw();
  }
  function onKey(event) {
    if (!armed || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    disarm();
    emit({ __maicInteractive: true, kind: 'element-picker-disarmed' });
  }
  function arm() {
    if (armed) { scheduleDraw(); return; }
    armed = true;
    ensureRoot();
    window.addEventListener('pointermove', onPointerMove, true);
    window.addEventListener('click', onClick, true);
    window.addEventListener('submit', block, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', scheduleDraw, true);
    window.addEventListener('resize', scheduleDraw);
    scheduleDraw();
  }
  function disarm() {
    if (!armed) return;
    armed = false;
    candidate = null;
    window.removeEventListener('pointermove', onPointerMove, true);
    window.removeEventListener('click', onClick, true);
    window.removeEventListener('submit', block, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('scroll', scheduleDraw, true);
    window.removeEventListener('resize', scheduleDraw);
    if (raf != null) { window.cancelAnimationFrame(raf); raf = null; }
    if (root) root.remove();
    root = null;
    hoverBox = null;
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event && event.data;
    if (!data || typeof data.type !== 'string') return;
    if (data.type === 'element-picker:arm') arm();
    else if (data.type === 'element-picker:disarm') disarm();
    else if (data.type === 'element-picker:sync') {
      selectors = Array.isArray(data.selectors) ? data.selectors.filter(function (item) { return typeof item === 'string'; }) : [];
      if (armed) scheduleDraw();
    }
  });
})();
</script>`;

/**
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Injects a runtime-error capture shim + a storage shim (so sandboxed pages that
 * use localStorage don't crash) plus CSS that ensures proper sizing and scrolling
 * behavior when HTML content is rendered via srcDoc in an iframe. The shims are
 * placed first so they run before the page's own scripts (error capture first, so
 * it also observes the storage shim).
 */
export function patchHtmlForIframe(html: string): string {
  /* A small number of legacy experiment generators emitted this fixed shell
     palette without semantic class names or CSS variables. Normalize only the
     shell neutrals/accent we have shipped; scientific/canvas colours remain
     untouched. This also repairs already-created classrooms. */
  const themedHtml = html
    .replace(/#1b1a2d/gi, '#102e39')
    .replace(/#1a203c/gi, '#173e49')
    .replace(/#1b1c31/gi, '#102e39')
    .replace(/#0f0f19/gi, '#071b23')
    .replace(/#54437a/gi, '#176b87')
    .replace(/#d4cddd/gi, '#eef7f8');
  const iframeCss = `<style data-iframe-patch>
  html, body {
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  /* Fix min-h-screen: in iframes 100vh is the iframe height, which is correct,
     but ensure body actually fills it */
  body { min-height: 100vh; }

  /* Keep legacy generated interactive pages visually aligned with the host.
     These selectors intentionally target only the old purple/indigo utility
     classes; scripts, layout, and the experiment's semantic markup remain
     untouched. */
  :root {
    --maic-iframe-background: #f4fafb;
    --maic-iframe-surface: #ffffff;
    --maic-iframe-primary: #176b87;
    --maic-iframe-primary-soft: #e6f4f6;
    --maic-iframe-border: #d7e3e8;
    --maic-iframe-foreground: #102a43;
    --maic-iframe-panel: #e8f3f5;
    /* Common variable names used by generated experiment templates. */
    --primary: #176b87 !important;
    --primary-color: #176b87 !important;
    --accent: #176b87 !important;
    --accent-color: #176b87 !important;
    --brand: #176b87 !important;
    --brand-color: #176b87 !important;
    --surface: #ffffff !important;
    --surface-color: #ffffff !important;
    --panel: #ffffff !important;
    --panel-color: #ffffff !important;
    --border-color: #d7e3e8 !important;
    --text-primary: #102a43 !important;
    --text-secondary: #587184 !important;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --maic-iframe-background: #071b23;
      --maic-iframe-surface: #102e39;
      --maic-iframe-primary: #4fb6c5;
      --maic-iframe-primary-soft: #173e49;
      --maic-iframe-border: #294953;
      --maic-iframe-foreground: #eef7f8;
      --maic-iframe-panel: #173e49;
      --primary: #4fb6c5 !important;
      --primary-color: #4fb6c5 !important;
      --accent: #4fb6c5 !important;
      --accent-color: #4fb6c5 !important;
      --brand: #4fb6c5 !important;
      --brand-color: #4fb6c5 !important;
      --surface: #102e39 !important;
      --surface-color: #102e39 !important;
      --panel: #102e39 !important;
      --panel-color: #102e39 !important;
      --border-color: #294953 !important;
      --text-primary: #eef7f8 !important;
      --text-secondary: #9ac2c9 !important;
    }
  }
  body {
    background: var(--maic-iframe-background) !important;
    color: var(--maic-iframe-foreground) !important;
  }
  body > :first-child,
  body > main,
  body > #root,
  body > #app {
    background-color: var(--maic-iframe-background) !important;
    color: var(--maic-iframe-foreground) !important;
  }
  /* Legacy simulations often use custom classes and hard-coded colors rather
     than utility classes. Scope compatibility overrides to common generated
     control/result regions so the experiment behavior and canvas stay intact. */
  #controls,
  #control-panel,
  [class*="control-panel"],
  [class*="controls"],
  [class*="card"],
  [class*="panel"] {
    background-color: var(--maic-iframe-panel) !important;
    border-color: var(--maic-iframe-border) !important;
    color: var(--maic-iframe-foreground) !important;
  }
  /* Generated experiments are inconsistent about class naming, but usually
     use semantic shell elements. Theme those containers without touching the
     canvas/SVG where subject-specific colours carry meaning. */
  :is(
    header,
    nav,
    aside,
    footer,
    [role="banner"],
    [role="navigation"],
    [role="complementary"],
    [class~="header"],
    [class~="sidebar"],
    [class~="toolbar"],
    [class~="footer"],
    [class~="statusbar"],
    [id="header"],
    [id="sidebar"],
    [id="toolbar"],
    [id="footer"],
    [id="statusbar"]
  ) {
    background-color: var(--maic-iframe-panel) !important;
    border-color: var(--maic-iframe-border) !important;
    color: var(--maic-iframe-foreground) !important;
  }
  :is(
    #controls,
    #control-panel,
    [class*="control-panel"],
    [class*="controls"],
    [class*="panel"],
    header,
    nav,
    aside,
    footer,
    [role="banner"],
    [role="navigation"],
    [role="complementary"],
    [class~="header"],
    [class~="sidebar"],
    [class~="toolbar"],
    [class~="footer"],
    [class~="statusbar"],
    [id="header"],
    [id="sidebar"],
    [id="toolbar"],
    [id="footer"],
    [id="statusbar"]
  ) :where(h1, h2, h3, h4, p, label, small, strong, [class*="title"], [class*="label"], [class*="caption"]) {
    color: var(--maic-iframe-foreground) !important;
  }
  :is(
    #controls,
    #control-panel,
    [class*="control-panel"],
    [class*="controls"],
    [class*="panel"],
    header,
    nav,
    aside,
    footer,
    [role="banner"],
    [role="navigation"],
    [role="complementary"],
    [class~="sidebar"],
    [class~="toolbar"],
    [class~="statusbar"],
    [id="sidebar"],
    [id="toolbar"],
    [id="statusbar"]
  ) svg {
    color: var(--maic-iframe-primary) !important;
  }
  button[id*="start"],
  button[id*="reset"],
  #start-btn,
  #reset-btn,
  #mainBtn {
    background-color: var(--maic-iframe-primary) !important;
    border-color: var(--maic-iframe-primary) !important;
    color: #ffffff !important;
  }
  input[type="range"] {
    accent-color: var(--maic-iframe-primary) !important;
  }
  input[type="range"]::-webkit-slider-thumb,
  input[type="range"]::-moz-range-thumb {
    background-color: var(--maic-iframe-primary) !important;
    border-color: var(--maic-iframe-primary) !important;
  }
  [id*="result"],
  [id*="output"],
  [class*="result"],
  [class*="output"] {
    background-color: var(--maic-iframe-surface) !important;
    border-color: var(--maic-iframe-border) !important;
    color: var(--maic-iframe-foreground) !important;
  }
  [class*="bg-slate-950"],
  [class*="bg-slate-900"],
  [class*="bg-gray-950"],
  [class*="bg-gray-900"],
  [class*="bg-zinc-950"],
  [class*="bg-zinc-900"] {
    background-color: var(--maic-iframe-surface) !important;
    background-image: none !important;
  }
  [class*="bg-violet-"],
  [class*="bg-purple-"],
  [class*="bg-indigo-"] {
    background-color: var(--maic-iframe-primary-soft) !important;
    background-image: none !important;
  }
  button[class*="bg-violet-"],
  button[class*="bg-purple-"],
  button[class*="bg-indigo-"],
  a[class*="bg-violet-"],
  a[class*="bg-purple-"],
  a[class*="bg-indigo-"] {
    background-color: var(--maic-iframe-primary) !important;
    color: #ffffff !important;
  }
  [class*="text-violet-"],
  [class*="text-purple-"],
  [class*="text-indigo-"] {
    color: var(--maic-iframe-primary) !important;
  }
  [class*="border-violet-"],
  [class*="border-purple-"],
  [class*="border-indigo-"] {
    border-color: var(--maic-iframe-border) !important;
  }
</style>`;

  const injection =
    '\n' + ERROR_CAPTURE_SHIM + '\n' + ELEMENT_PICKER_SHIM + '\n' + STORAGE_SHIM + '\n' + iframeCss;

  return injectIntoDocumentHead(themedHtml, injection);
}
