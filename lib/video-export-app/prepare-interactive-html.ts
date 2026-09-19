'use client';

/**
 * Deep app-side module that turns authored interactive HTML into bounded,
 * self-contained pages ready for the pure video compiler and byte collector.
 */
import type { Scene } from '@/lib/types/stage';
import { inlineHtmlAssets, type FetchAsset } from '@/lib/export/inline-assets';
import { injectIntoDocumentHead } from '@/lib/utils/html-document';
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

function staticCaptureInjection(): string {
  const flag = JSON.stringify(INTERACTIVE_STATIC_MESSAGE_FLAG);
  const settleMs = INTERACTIVE_SETTLE_MS;
  const internalTimeoutMs = Math.max(1_000, INTERACTIVE_READY_TIMEOUT_MS - 1_000);
  return `
<meta data-openmaic-static-csp http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; worker-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'">
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

  function disabledWorker() { throw new Error('interactive-worker-disabled'); }
  try { window.Worker = disabledWorker; } catch (_) {}
  try { window.SharedWorker = disabledWorker; } catch (_) {}

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
        if ((img.currentSrc || img.src || img.getAttribute('srcset')) && img.naturalWidth === 0)
          return Promise.reject(new Error('interactive-image-load-failure'));
        return typeof img.decode === 'function' ? img.decode() : Promise.resolve();
      }
      return new Promise(function (resolve, reject) {
        img.addEventListener('load', resolve, { once: true });
        img.addEventListener(
          'error',
          function () { reject(new Error('interactive-image-load-failure')); },
          { once: true },
        );
      });
    }));
  }

  function waitForVideos() {
    return Promise.all(Array.from(document.querySelectorAll('video')).map(function (video) {
      if (!video.currentSrc && !video.getAttribute('src') && !video.querySelector('source')) return Promise.resolve();
      if (video.readyState >= 2) return Promise.resolve();
      return new Promise(function (resolve, reject) {
        video.addEventListener('loadeddata', resolve, { once: true });
        video.addEventListener(
          'error',
          function () { reject(new Error('interactive-video-load-failure')); },
          { once: true },
        );
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
      deadlineTimer = nativeSetTimeout(function () { reject(new Error('interactive-readiness-timeout')); }, ${internalTimeoutMs});
    });
    Promise.race([readiness, deadline])
      .then(function () {
        nativeClearTimeout(deadlineTimer);
        return new Promise(function (resolve) { nativeSetTimeout(resolve, ${settleMs}); });
      })
      .then(function () { freeze(); post('frozen', 'interactive-static-ready', 'ready'); })
      .catch(function (error) {
        nativeClearTimeout(deadlineTimer);
        freeze();
        post('failure', 'interactive-ready-failure', error && error.message || error);
      });
  }, { once: true });
})();
</script>`;
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

class PreparedInteractiveHtmlSetImpl implements PreparedInteractiveHtmlSet {
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
  return new PreparedInteractiveHtmlSetImpl(new Map(), new Map());
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
      const {
        html: inlined,
        report,
        unresolved,
      } = await inlineHtmlAssets(authored, {
        fetcher: options.fetcher,
        keepImportmapFallbacks: false,
      });
      const sanitized = stripInvalidFontFallbacks(inlined);
      const residual = [
        ...new Set([
          ...report.failed
            .map((failure) => failure.url)
            .filter((url) => !/^about:invalid$/i.test(url)),
          ...unresolved,
        ]),
      ];
      if (residual.length > 0) {
        bySceneId.set(scene.id, {
          id: assetId,
          present: false,
          failure: 'unresolved-resource',
          message: `unresolved-interactive-resource:${residual.slice(0, 3).join(', ')}${residual.length > 3 ? ` (+${residual.length - 3} more)` : ''}`,
        });
        continue;
      }

      const packaged = injectIntoDocumentHead(
        patchHtmlForIframe(sanitized),
        staticCaptureInjection(),
      );
      const size = new TextEncoder().encode(packaged).byteLength;
      if (size > maxBytes) {
        bySceneId.set(scene.id, {
          id: assetId,
          present: false,
          failure: 'too-large',
          message: `interactive-html-too-large:${size}/${maxBytes}`,
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
        message: `interactive-html-packaging-failed:${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return new PreparedInteractiveHtmlSetImpl(bySceneId, byAssetId);
}

declare global {
  interface Window {
    __openmaicFreezeInteractive?: () => void;
  }
}
