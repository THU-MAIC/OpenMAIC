'use client';

import { useMemo } from 'react';
import type { InteractiveContent } from '@/lib/types/stage';

interface InteractiveRendererProps {
  readonly content: InteractiveContent;
  readonly mode: 'autonomous' | 'playback';
  readonly sceneId: string;
}

/**
 * In-memory localStorage/sessionStorage shim, injected as the FIRST thing in the
 * document so the page's own scripts see working storage.
 *
 * The interactive iframe is sandboxed `allow-scripts` WITHOUT `allow-same-origin`
 * (intentional — combining them negates the sandbox for LLM-authored HTML). In a
 * null-origin document, touching `window.localStorage` throws a SecurityError;
 * many generated pages read/write storage in their setup code, so that throw
 * crashes the script before anything renders.
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
 * Runtime-error capture shim. The sandboxed iframe cannot be inspected directly,
 * but it can `postMessage` outward when generated widget code fails early.
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
})();
</script>`;

export function InteractiveRenderer({ content, mode: _mode, sceneId }: InteractiveRendererProps) {
  const patchedHtml = useMemo(
    () => (content.html ? patchHtmlForIframe(content.html) : undefined),
    [content.html],
  );

  return (
    <div className="flex h-full min-h-0 min-w-0 w-full bg-[#18233d] px-4 py-5 sm:px-6 sm:py-6">
      <div className="flex h-full min-h-0 min-w-0 w-full items-center justify-center">
        <div className="flex h-full min-h-0 min-w-0 w-full max-w-[1120px] flex-col">
          <div className="min-h-0 min-w-0 flex-1 overflow-hidden rounded-[22px] border border-white/10 bg-[#0f172a]/30 p-2 shadow-[0_24px_80px_rgba(2,6,23,0.35)] backdrop-blur-sm sm:p-3">
            <iframe
              srcDoc={patchedHtml}
              src={patchedHtml ? undefined : content.url}
              className="h-full w-full rounded-[18px] border-0 bg-white shadow-[inset_0_1px_0_rgba(255,255,255,0.45)]"
              title={`Interactive Scene ${sceneId}`}
              sandbox="allow-scripts allow-forms allow-popups"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Patch embedded HTML to display correctly inside an iframe.
 *
 * Injects shims plus CSS that keeps interactive widgets bounded, scrollable, and
 * less prone to simulation/panel overlap inside the classroom canvas.
 */
export function patchHtmlForIframe(html: string): string {
  const iframeCss = `<style data-iframe-patch>
  *, *::before, *::after {
    box-sizing: border-box;
  }
  html, body {
    width: 100%;
    height: 100%;
    max-width: 100%;
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
  }
  body {
    min-height: 100vh;
    padding: 0 !important;
    background: linear-gradient(180deg, #dbe7ff 0%, #eff4ff 100%);
    color: #0f172a;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-size: 14px !important;
    line-height: 1.35 !important;
  }
  body > * {
    max-width: 100% !important;
  }
  body > main,
  body > .app,
  body > .simulation-shell,
  body > .game-shell,
  body > .activity-shell,
  body > [class*="app-shell"],
  body > [class*="simulation-shell"],
  body > [class*="game-shell"] {
    width: min(100%, 1120px) !important;
    margin: 0 auto !important;
  }
  h1 {
    font-size: 22px !important;
    line-height: 1.15 !important;
    margin: 0 0 10px !important;
  }
  h2 {
    font-size: 18px !important;
    line-height: 1.2 !important;
    margin: 0 0 8px !important;
  }
  h3, h4 {
    font-size: 15px !important;
    line-height: 1.25 !important;
    margin: 0 0 6px !important;
  }
  p, label, li {
    font-size: 13px !important;
    line-height: 1.35 !important;
  }
  img, video, canvas, svg {
    max-width: 100%;
  }
  pre, code, kbd, samp {
    font-size: 12px !important;
    line-height: 1.35 !important;
    white-space: pre-wrap !important;
  }
  button, input, select, textarea {
    font: inherit;
  }
  button, [role="button"] {
    min-height: 34px !important;
    border: 0;
    border-radius: 10px !important;
    padding: 8px 11px !important;
    background: #2563eb;
    color: #ffffff;
    font-size: 13px !important;
    font-weight: 700;
    box-shadow: 0 8px 18px rgba(37, 99, 235, 0.18);
    cursor: pointer;
  }
  button:hover, [role="button"]:hover {
    background: #1d4ed8;
  }
  button:disabled, [role="button"][aria-disabled="true"] {
    opacity: 0.55;
    cursor: not-allowed;
  }
  input:not([type="range"]), select, textarea {
    width: 100%;
    border: 1px solid #cbd5e1;
    border-radius: 10px;
    padding: 8px 10px;
    background: #ffffff;
    color: #0f172a;
    font-size: 13px !important;
  }
  input[type="range"] {
    width: 100%;
    accent-color: #7c3aed;
  }
  table {
    width: 100%;
    border-collapse: collapse;
  }
  th, td {
    padding: 8px;
    border-bottom: 1px solid #e2e8f0;
    text-align: left;
    font-size: 13px !important;
  }
  .simulation-shell,
  .game-shell,
  .game-stage,
  .activity-shell,
  .matrix-card,
  .card,
  section,
  article {
    max-width: 100%;
  }
  .simulation-shell,
  .game-shell,
  .activity-shell {
    width: min(100%, 1120px) !important;
    max-width: 1120px !important;
    margin-left: auto !important;
    margin-right: auto !important;
    position: relative;
    min-height: 100vh !important;
    padding: 18px !important;
    align-items: stretch !important;
    gap: 18px !important;
  }
  .simulation-shell,
  .game-shell {
    grid-template-columns: minmax(220px, 320px) minmax(0, 1fr) !important;
  }
  .simulation-shell > *,
  .game-shell > *,
  .activity-shell > * {
    min-width: 0 !important;
  }
  .game-stage,
  .simulation-stage,
  .canvas-stage,
  [class*="stage"],
  [class*="viewport"],
  [class*="canvas"] {
    position: relative;
    min-width: 0 !important;
    width: 100% !important;
    overflow: hidden !important;
    border-radius: 22px !important;
    border: 1px solid rgba(148, 163, 184, 0.35) !important;
    box-shadow: 0 20px 55px rgba(15, 23, 42, 0.14) !important;
    max-height: calc(100vh - 110px) !important;
  }
  .card,
  .matrix-card,
  section,
  article,
  [class*="panel"],
  [class*="card"] {
    border-radius: 12px !important;
    padding: 12px !important;
  }
  [class*="label"],
  [class*="badge"],
  [class*="chip"],
  [class*="tag"] {
    display: inline-flex !important;
    align-items: center !important;
    max-width: 100% !important;
    overflow-wrap: anywhere !important;
    white-space: normal !important;
    font-size: 12px !important;
    line-height: 1.2 !important;
  }
  [class*="toolbar"],
  [class*="hud"],
  [class*="control-bar"],
  [class*="action-bar"] {
    display: flex !important;
    flex-wrap: wrap !important;
    align-items: center !important;
    gap: 10px !important;
    max-width: 100% !important;
  }
  [class*="score"],
  [class*="coins"],
  [class*="points"],
  [class*="status"],
  [class*="hud-card"],
  [class*="counter"] {
    display: inline-flex !important;
    align-items: center !important;
    justify-content: center !important;
    gap: 8px !important;
    padding: 10px 14px !important;
    border-radius: 999px !important;
    background: rgba(255, 255, 255, 0.94) !important;
    box-shadow: 0 10px 24px rgba(15, 23, 42, 0.12) !important;
    max-width: min(100%, 180px) !important;
    overflow-wrap: anywhere !important;
  }
  [class*="overlay"] {
    max-width: min(100%, 320px) !important;
  }
  [class*="ground"],
  [class*="soil"],
  [class*="grass"] {
    overflow: hidden !important;
  }
  [class*="shop"],
  [class*="inventory"],
  [class*="selector"],
  [class*="toolbox"],
  [class*="choices"] {
    max-width: min(100%, 360px) !important;
    margin-left: auto !important;
    margin-right: auto !important;
  }
  [class*="bottom-bar"],
  [class*="bottom-controls"],
  [class*="footer-controls"],
  [class*="control-dock"],
  [class*="dock"] {
    position: sticky !important;
    bottom: 12px !important;
    z-index: 5 !important;
    display: flex !important;
    justify-content: center !important;
    gap: 12px !important;
    width: fit-content !important;
    max-width: calc(100% - 24px) !important;
    margin: 0 auto !important;
    padding: 12px 16px !important;
    border-radius: 999px !important;
    background: rgba(255, 255, 255, 0.92) !important;
    box-shadow: 0 16px 38px rgba(15, 23, 42, 0.16) !important;
    backdrop-filter: blur(14px) !important;
  }
  [class*="selector"] > *,
  [class*="toolbox"] > *,
  [class*="choices"] > *,
  [class*="bottom-controls"] > *,
  [class*="control-dock"] > *,
  [class*="dock"] > * {
    flex: 0 0 auto !important;
  }
  @media (max-height: 620px), (max-width: 640px) {
    body {
      font-size: 13px !important;
    }
    .simulation-shell,
    .game-shell,
    .activity-shell {
      padding: 10px !important;
      gap: 12px !important;
    }
    .simulation-shell,
    .game-shell {
      grid-template-columns: 1fr !important;
    }
    button, [role="button"] {
      min-height: 32px !important;
      padding: 7px 10px !important;
    }
    .game-stage,
    .simulation-stage,
    .canvas-stage,
    [class*="stage"],
    [class*="viewport"],
    [class*="canvas"] {
      max-height: calc(100vh - 88px) !important;
    }
    [class*="overlay"] {
      position: static !important;
      width: auto !important;
      max-width: 100% !important;
      margin: 12px 0 0 !important;
    }
    [class*="bottom-bar"],
    [class*="bottom-controls"],
    [class*="footer-controls"],
    [class*="control-dock"],
    [class*="dock"] {
      bottom: 8px !important;
      max-width: calc(100% - 16px) !important;
      padding: 10px 12px !important;
      gap: 8px !important;
    }
  }
  </style>`;

  const injection = '\n' + ERROR_CAPTURE_SHIM + '\n' + STORAGE_SHIM + '\n' + iframeCss;

  const headIdx = html.indexOf('<head>');
  if (headIdx !== -1) {
    const insertPos = headIdx + 6;
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

  return injection + html;
}
