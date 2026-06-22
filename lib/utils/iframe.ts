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
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Injects a storage shim (so sandboxed pages that use localStorage don't crash)
 * plus CSS that ensures proper sizing and scrolling behavior when HTML content is
 * rendered via srcDoc in an iframe. The shim is placed first so it runs before
 * the page's own scripts.
 */
export function patchHtmlForIframe(html: string): string {
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

  const injection = '\n' + STORAGE_SHIM + '\n' + iframeCss;

  // Insert right after <head> or at the start of the document
  const headIdx = html.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6; // after <head>
    return html.substring(0, insertPos) + injection + html.substring(insertPos);
  }

  const headWithAttrs = html.indexOf('<head ');
  if (headWithAttrs !== -1) {
    const closeAngle = html.indexOf('>', headWithAttrs);
    if (closeAngle !== -1) {
      const insertPos = closeAngle + 1;
      return html.substring(0, insertPos) + injection + html.substring(insertPos);
    }
  }

  // Fallback: prepend
  return injection + html;
}
