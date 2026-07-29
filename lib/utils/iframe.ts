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

/**
 * Repair a common LLM-authored Pyodide bootstrap bug.
 *
 * `micropip` ships with the Pyodide distribution but is not loaded into the
 * runtime by `loadPyodide()` itself. Generated widgets sometimes immediately
 * execute `import micropip`, which aborts their whole initialization with
 * `ModuleNotFoundError`. When that exact mismatch is present, insert the
 * documented `loadPackage('micropip')` call after the assigned loader promise.
 *
 * This is intentionally narrow: unrelated HTML is untouched, already-correct
 * widgets stay byte-for-byte stable, and pages whose loader result is not
 * assigned are left for the runtime-error reporter instead of being guessed at.
 */
function patchMissingMicropipLoad(html: string): string {
  if (!/\b(?:import\s+micropip|from\s+micropip\s+import)\b/.test(html)) return html;
  if (/\.loadPackage\s*\(\s*(?:['"]micropip['"]|\[[^\]]*['"]micropip['"][^\]]*\])/.test(html)) {
    return html;
  }

  const loader = /\b([A-Za-z_$][\w$]*)\s*=\s*await\s+loadPyodide\s*\(/.exec(html);
  if (!loader || loader.index === undefined) return html;

  const variable = loader[1];
  const openParen = html.indexOf('(', loader.index);
  if (openParen === -1) return html;

  let depth = 0;
  let quote = '';
  let escaped = false;
  let blockComment = false;
  let lineComment = false;
  let closeParen = -1;

  for (let index = openParen; index < html.length; index += 1) {
    const char = html[index];
    const next = html[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        closeParen = index;
        break;
      }
    }
  }

  if (closeParen === -1) return html;

  let insertAt = closeParen + 1;
  let crossedLineBreak = false;
  while (insertAt < html.length && /[ \t\r\n]/.test(html[insertAt])) {
    if (html[insertAt] === '\n' || html[insertAt] === '\r') crossedLineBreak = true;
    insertAt += 1;
  }

  // A property-access token means the result is still part of a chain such as
  // `loadPyodide().then(...)`; inserting in the middle would corrupt the script.
  if (html[insertAt] === '.' || html[insertAt] === '?' || html[insertAt] === '[') return html;

  if (html[insertAt] === ';') insertAt += 1;
  else if (
    insertAt < html.length &&
    !crossedLineBreak &&
    html[insertAt] !== '}' &&
    html[insertAt] !== '<'
  ) {
    return html;
  }

  const lineStart = html.lastIndexOf('\n', loader.index) + 1;
  const indentation = html.slice(lineStart, loader.index).match(/^[ \t]*/)?.[0] ?? '';
  const loadStatement = `\n${indentation}await ${variable}.loadPackage('micropip');`;

  return html.slice(0, insertAt) + loadStatement + html.slice(insertAt);
}

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
  const runtimePatchedHtml = patchMissingMicropipLoad(html);
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
</style>`;

  const injection = '\n' + ERROR_CAPTURE_SHIM + '\n' + STORAGE_SHIM + '\n' + iframeCss;

  // Insert right after <head> or at the start of the document
  const headIdx = runtimePatchedHtml.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6; // after <head>
    return (
      runtimePatchedHtml.substring(0, insertPos) +
      injection +
      runtimePatchedHtml.substring(insertPos)
    );
  }

  const headWithAttrs = runtimePatchedHtml.indexOf('<head ');
  if (headWithAttrs !== -1) {
    const closeAngle = runtimePatchedHtml.indexOf('>', headWithAttrs);
    if (closeAngle !== -1) {
      const insertPos = closeAngle + 1;
      return (
        runtimePatchedHtml.substring(0, insertPos) +
        injection +
        runtimePatchedHtml.substring(insertPos)
      );
    }
  }

  // Fallback: prepend
  return injection + runtimePatchedHtml;
}
