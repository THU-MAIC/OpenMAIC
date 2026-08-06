'use client';

/**
 * Deep app-side module that turns authored interactive HTML into bounded,
 * self-contained pages ready for the pure video compiler and byte collector.
 */
import type { Scene } from '@/lib/types/stage';
import { collectAssetRefs, inlineHtmlAssets, type FetchAsset } from '@/lib/export/inline-assets';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import type { InteractiveHtmlMeta, InteractiveHtmlSource } from '@/lib/video-export/deps';
import {
  INTERACTIVE_READY_TIMEOUT_MS,
  INTERACTIVE_SETTLE_MS,
  INTERACTIVE_STATIC_MESSAGE_FLAG,
} from '@/lib/video-export/interactive-static';

const DEFAULT_MAX_HTML_BYTES = 32 * 1024 * 1024;

export interface PreparedInteractiveHtmlSet extends InteractiveHtmlSource {
  /** Exact packaged HTML for an owning asset-plan entry. */
  content(assetId: string): string | undefined;
}

export interface PrepareInteractiveHtmlOptions {
  fetcher?: FetchAsset;
  maxHtmlBytes?: number;
}

function insertAfterHead(html: string, injection: string): string {
  const match = /<head(?:\s[^>]*)?>/i.exec(html);
  if (!match || match.index === undefined) return injection + html;
  const pos = match.index + match[0].length;
  return html.slice(0, pos) + injection + html.slice(pos);
}

function staticCaptureInjection(): string {
  const flag = JSON.stringify(INTERACTIVE_STATIC_MESSAGE_FLAG);
  const settleMs = INTERACTIVE_SETTLE_MS;
  const internalTimeoutMs = Math.max(1_000, INTERACTIVE_READY_TIMEOUT_MS - 1_000);
  return `
<meta data-openmaic-static-csp http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; worker-src data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'">
<script data-openmaic-static-capture>
(function () {
  var FLAG = ${flag};
  var frozen = false;
  var timeouts = new Set();
  var intervals = new Set();
  var rafs = new Set();
  var nativeSetTimeout = window.setTimeout.bind(window);
  var nativeClearTimeout = window.clearTimeout.bind(window);
  var nativeSetInterval = window.setInterval.bind(window);
  var nativeClearInterval = window.clearInterval.bind(window);
  var nativeRaf = window.requestAnimationFrame.bind(window);
  var nativeCancelRaf = window.cancelAnimationFrame.bind(window);

  function post(kind, code, message) {
    try {
      var payload = {
        kind: kind,
        code: code,
        message: String(message || '').slice(0, 1200)
      };
      payload[FLAG] = true;
      window.parent.postMessage(payload, '*');
    } catch (_) {}
  }

  window.setTimeout = function (fn, delay) {
    if (frozen) return 0;
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nativeSetTimeout(function () {
      timeouts.delete(id);
      if (!frozen) {
        if (typeof fn === 'function') fn.apply(window, args);
        else Function(String(fn))();
      }
    }, delay);
    timeouts.add(id);
    return id;
  };
  window.clearTimeout = function (id) { timeouts.delete(id); nativeClearTimeout(id); };
  window.setInterval = function (fn, delay) {
    if (frozen) return 0;
    var args = Array.prototype.slice.call(arguments, 2);
    var id = nativeSetInterval(function () {
      if (!frozen) {
        if (typeof fn === 'function') fn.apply(window, args);
        else Function(String(fn))();
      }
    }, delay);
    intervals.add(id);
    return id;
  };
  window.clearInterval = function (id) { intervals.delete(id); nativeClearInterval(id); };
  window.requestAnimationFrame = function (fn) {
    if (frozen) return 0;
    var id = nativeRaf(function (time) {
      rafs.delete(id);
      if (!frozen) fn(time);
    });
    rafs.add(id);
    return id;
  };
  window.cancelAnimationFrame = function (id) { rafs.delete(id); nativeCancelRaf(id); };

  function waitForImages() {
    return Promise.all(Array.from(document.images || []).map(function (img) {
      if (img.complete) {
        if (img.src && img.naturalWidth === 0) return Promise.reject(new Error('Image failed to load'));
        return typeof img.decode === 'function' ? img.decode().catch(function () {}) : Promise.resolve();
      }
      return new Promise(function (resolve, reject) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener('error', function () { reject(new Error('Image failed to load')); }, { once: true });
      });
    }));
  }

  function waitForVideos() {
    return Promise.all(Array.from(document.querySelectorAll('video')).map(function (video) {
      if (!video.currentSrc && !video.getAttribute('src') && !video.querySelector('source')) return Promise.resolve();
      if (video.readyState >= 2) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        video.addEventListener('loadeddata', resolve, { once: true });
        video.addEventListener('error', function () { reject(new Error('Video failed to load')); }, { once: true });
      });
    }));
  }

  function freeze() {
    if (frozen) return;
    frozen = true;
    timeouts.forEach(nativeClearTimeout); timeouts.clear();
    intervals.forEach(nativeClearInterval); intervals.clear();
    rafs.forEach(nativeCancelRaf); rafs.clear();
    try { document.getAnimations().forEach(function (animation) { animation.pause(); }); } catch (_) {}
    Array.from(document.querySelectorAll('video,audio')).forEach(function (media) {
      try { media.pause(); } catch (_) {}
    });
    var style = document.createElement('style');
    style.setAttribute('data-openmaic-static-frozen', '');
    style.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
    (document.head || document.documentElement).appendChild(style);
    document.documentElement.setAttribute('data-openmaic-static-state', 'frozen');
  }

  window.__openmaicFreezeInteractive = freeze;
  window.addEventListener('load', function () {
    var fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve();
    var readiness = Promise.all([fonts, waitForImages(), waitForVideos()]);
    var deadlineTimer;
    var deadline = new Promise(function (_, reject) {
      deadlineTimer = nativeSetTimeout(function () { reject(new Error('Interactive readiness timed out')); }, ${internalTimeoutMs});
    });
    Promise.race([readiness, deadline])
      .then(function () {
        nativeClearTimeout(deadlineTimer);
        return new Promise(function (resolve) { nativeSetTimeout(resolve, ${settleMs}); });
      })
      .then(function () { freeze(); post('frozen', 'interactive-static-ready', 'ready'); })
      .catch(function (error) {
        nativeClearTimeout(deadlineTimer);
        post('failure', 'interactive-ready-failure', error && error.message || error);
      });
  }, { once: true });
})();
</script>`;
}

function unsupportedAssetRefs(html: string): string[] {
  const refs = new Set<string>();
  const add = (value: string | undefined) => {
    const url = value?.trim();
    if (!url || /^(?:data:|blob:|about:|#)/i.test(url)) return;
    refs.add(url);
  };

  for (const match of html.matchAll(/<(?:link|base)\b[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi))
    add(match[1]);
  for (const match of html.matchAll(
    /<(?:script|img|source|video|audio)\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
  ))
    add(match[1]);
  for (const match of html.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/gi)) add(match[1]);
  for (const match of html.matchAll(
    /<script\b[^>]*type\s*=\s*["']importmap["'][^>]*>([\s\S]*?)<\/script>/gi,
  )) {
    try {
      const imports = (JSON.parse(match[1]) as { imports?: Record<string, string> }).imports ?? {};
      for (const url of Object.values(imports)) add(url);
    } catch {
      refs.add('malformed importmap');
    }
  }
  return [...refs];
}

/** KaTeX emits `about:invalid` font fallbacks after its embedded data fonts. */
function stripInvalidFontFallbacks(html: string): string {
  return html.replace(
    /url\(\s*about:invalid\s*\)(?:\s*format\(\s*["'][^"']+["']\s*\))?\s*,?/gi,
    '',
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

class PreparedSet implements PreparedInteractiveHtmlSet {
  constructor(
    private readonly bySceneId: ReadonlyMap<string, InteractiveHtmlMeta>,
    private readonly byAssetId: ReadonlyMap<string, string>,
  ) {}

  html(scene: { id: string }): InteractiveHtmlMeta | null {
    return this.bySceneId.get(scene.id) ?? null;
  }

  content(assetId: string): string | undefined {
    return this.byAssetId.get(assetId);
  }
}

export function emptyPreparedInteractiveHtmlSet(): PreparedInteractiveHtmlSet {
  return new PreparedSet(new Map(), new Map());
}

export async function prepareInteractiveHtmlScenes(
  scenes: readonly Scene[],
  options: PrepareInteractiveHtmlOptions = {},
): Promise<PreparedInteractiveHtmlSet> {
  const bySceneId = new Map<string, InteractiveHtmlMeta>();
  const byAssetId = new Map<string, string>();
  const maxBytes = options.maxHtmlBytes ?? DEFAULT_MAX_HTML_BYTES;

  for (const scene of scenes) {
    if (scene.content.type !== 'interactive') continue;
    const assetId = `interactive:${scene.id}`;
    const authored = scene.content.html;
    if (!authored?.trim()) {
      bySceneId.set(scene.id, {
        id: assetId,
        present: false,
        failure: 'missing-html',
      });
      continue;
    }

    try {
      const { html: inlined, report } = await inlineHtmlAssets(authored, {
        fetcher: options.fetcher,
        keepImportmapFallbacks: false,
      });
      const sanitized = stripInvalidFontFallbacks(inlined);
      const residual = [
        ...new Set([
          ...report.failed
            .map((failure) => failure.url)
            .filter((url) => !/^about:invalid$/i.test(url)),
          ...collectAssetRefs(sanitized).map((ref) => ref.url),
          ...unsupportedAssetRefs(sanitized),
        ]),
      ];
      if (residual.length > 0) {
        bySceneId.set(scene.id, {
          id: assetId,
          present: false,
          failure: 'unresolved-resource',
          message: `Interactive HTML has unresolved resources: ${residual.slice(0, 3).join(', ')}${residual.length > 3 ? ` (+${residual.length - 3} more)` : ''}.`,
        });
        continue;
      }

      const packaged = insertAfterHead(patchHtmlForIframe(sanitized), staticCaptureInjection());
      const size = new TextEncoder().encode(packaged).byteLength;
      if (size > maxBytes) {
        bySceneId.set(scene.id, {
          id: assetId,
          present: false,
          failure: 'too-large',
          message: `Interactive HTML is ${size} bytes after inlining (limit ${maxBytes}).`,
        });
        continue;
      }

      const contentHash = await sha256(packaged);
      bySceneId.set(scene.id, { id: assetId, present: true, contentHash });
      byAssetId.set(assetId, packaged);
    } catch (error) {
      bySceneId.set(scene.id, {
        id: assetId,
        present: false,
        failure: 'packaging-failed',
        message: `Interactive HTML packaging failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return new PreparedSet(bySceneId, byAssetId);
}

declare global {
  interface Window {
    __openmaicFreezeInteractive?: () => void;
  }
}
