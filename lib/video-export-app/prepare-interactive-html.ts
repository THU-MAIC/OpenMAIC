'use client';

/**
 * Deep app-side module that turns authored interactive HTML into bounded,
 * self-contained pages ready for the pure video compiler and byte collector.
 */
import type { Scene } from '@/lib/types/stage';
import { createAssetFetcher, inlineHtmlAssets, type FetchAsset } from '@/lib/export/inline-assets';
import { sha256BytesHex } from '@/lib/legacy-browser-import/digest';
import { injectIntoDocumentHead } from '@/lib/utils/html-document';
import { patchHtmlForIframe } from '@/lib/utils/iframe';
import type { InteractiveHtmlMeta, InteractiveHtmlSource } from '@/lib/video-export/deps';
import {
  INTERACTIVE_READY_TIMEOUT_MS,
  INTERACTIVE_SETTLE_MS,
  INTERACTIVE_STATIC_MESSAGE_FLAG,
} from '@/lib/video-export/interactive-static';
import { MAX_VIDEO_CAPTURE_ASSET_BYTES, prepareCaptureAssets } from './prepare-capture-assets';

// Pyodide 0.26 with NumPy needs about 33 MiB after base64 encoding.
const DEFAULT_MAX_HTML_BYTES = 40 * 1024 * 1024;

export interface PreparedInteractiveHtmlSet extends InteractiveHtmlSource {
  /** Exact packaged HTML for an owning asset-plan entry. */
  content(assetId: string): string | undefined;
}

export interface PrepareInteractiveHtmlOptions {
  /** Deployment origin when packaging outside a browser. */
  baseUrl?: string;
  fetcher?: FetchAsset;
  maxHtmlBytes?: number;
}

function staticCaptureInjection(offlineAssets: ReadonlyArray<[string, string]>): string {
  const flag = JSON.stringify(INTERACTIVE_STATIC_MESSAGE_FLAG);
  const settleMs = INTERACTIVE_SETTLE_MS;
  const internalTimeoutMs = Math.max(1_000, INTERACTIVE_READY_TIMEOUT_MS - 1_000);
  return `
<meta data-openmaic-static-csp http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data:; img-src data: blob:; font-src data:; media-src data: blob:; worker-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'">
<script data-openmaic-static-capture>
(function () {
  var FLAG = ${flag};
  var frozen = false;
  var capturing = false;
  var timerId = 0;
  var frameId = 0;
  var pumpTimer;
  var sceneTime = 0;
  var frameOrigin = 0;
  var nextFrameAt = Infinity;
  var frameStartAt = 0;
  var frameNumber = 0;
  var drawingUntimedFrame = false;
  var timers = new Map();
  var rafs = new Map();
  var runtimes = new Set();
  var blockingRuntimes = 0;
  var browserTasks = new Set();
  var runtimeRevision = 0;
  var animations = new Map();
  var nativeSetTimeout = window.setTimeout.bind(window);
  var nativeClearTimeout = window.clearTimeout.bind(window);
  var browserNow = Performance.prototype.now.bind(performance);
  function captureNow() { return frozen ? frameOrigin + sceneTime : browserNow(); }
  var taskChannel = new MessageChannel();
  var taskWaiters = [];
  taskChannel.port1.onmessage = function () { taskWaiters.shift()(); };
  function yieldToBrowser() {
    return new Promise(function (resolve) { taskWaiters.push(resolve); taskChannel.port2.postMessage(null); });
  }
  Object.defineProperty(performance, 'now', { configurable: true, value: captureNow });

  // The producer installs an epoch-zero clock in every served HTML document.
  // Keep a wall-clock origin for authored dates while driving seeks locally.
  var OriginalDate = window.Date;
  var epoch = performance.timeOrigin;
  function CaptureDate() {
    if (!new.target) return new OriginalDate(CaptureDate.now()).toString();
    var args = arguments.length ? Array.from(arguments) : [CaptureDate.now()];
    return Object.setPrototypeOf(Reflect.construct(OriginalDate, args), new.target.prototype);
  }
  CaptureDate.prototype = OriginalDate.prototype;
  Object.setPrototypeOf(CaptureDate, OriginalDate);
  CaptureDate.now = function () { return Math.floor(epoch + captureNow()); };
  window.Date = CaptureDate;
${
  offlineAssets.length > 0
    ? `
  var offlineAssets = new Map(${JSON.stringify(offlineAssets).replace(/</g, '\\u003c')});
  window.__openmaicOfflineAsset = function (url) {
    var key = new URL(url).href;
    if (!offlineAssets.has(key)) throw new Error('Undeclared offline asset: ' + key);
    return offlineAssets.get(key);
  };
  window.__openmaicFetchOfflineAsset = async function (url) {
    var data = window.__openmaicOfflineAsset(url);
    var comma = data.indexOf(',');
    var mime = data.slice(5, comma - ';base64'.length);
    var body = Uint8Array.from(atob(data.slice(comma + 1)), function (char) { return char.charCodeAt(0); });
    return new Response(body, { headers: { 'Content-Type': mime } });
  };
`
    : ''
}

  // Hyperframes can pause native rAF before it discovers the timeline.
  // A task-based pump lets even a multi-frame startup finish first.
  async function drawFrame(time, includeUntimedFrames, skipTimedThrough) {
    for (var id of Array.from(rafs.keys())) {
      var frame = rafs.get(id);
      if (!frame || (!frame.timed && !includeUntimedFrames)) continue;
      if (frame.timed && id <= skipTimedThrough) continue;
      rafs.delete(id);
      drawingUntimedFrame = !frame.timed;
      try { frame.callback(time); } catch (error) { window.reportError(error); }
      // Keep frames requeued from this callback's microtasks in the same mode.
      if (frozen && drawingUntimedFrame) await yieldToBrowser();
      drawingUntimedFrame = false;
    }
  }

  function pumpFrames() {
    if (!frozen && pumpTimer === undefined && rafs.size) {
      pumpTimer = nativeSetTimeout(async function () {
        pumpTimer = undefined;
        await drawFrame(browserNow(), true, 0);
        pumpFrames();
      }, 16);
    }
  }

  window.__openmaicWaitForStaticRuntime = function (ready, options) {
    var result = Promise.resolve(ready);
    runtimeRevision++;
    var settled = result.then(function () {}, function () {});
    var blocking = options && options.blockCapture === true;
    if (blocking) blockingRuntimes++;
    runtimes.add(settled);
    settled.then(function () {
      runtimes.delete(settled);
      if (blocking) blockingRuntimes--;
    });
    return result.then(function (value) { return value; });
  };

  // Track delivery of native scheduled tasks while a registered runtime is
  // settling. Their callbacks may in turn wait for the scene clock.
  if (window.scheduler && typeof window.scheduler.postTask === 'function') {
    var nativePostTask = window.scheduler.postTask.bind(window.scheduler);
    window.scheduler.postTask = function (callback, options) {
      if (!frozen || typeof callback !== 'function') return nativePostTask(callback, options);
      var key = {};
      var done = function () { browserTasks.delete(key); };
      var task = nativePostTask(function () { done(); return callback(); }, options);
      browserTasks.add(key);
      return task.finally(done);
    };
  }

  function sleep(ms) {
    return new Promise(function (resolve) { nativeSetTimeout(resolve, ms); });
  }

  async function settleStartup(legacyChecks) {
    await waitForVisualAssets();
    for (;;) {
      var revision = runtimeRevision;
      await Promise.all(Array.from(runtimes));
      await sleep(${settleMs});
      // A resource loaded during settling can itself register a draw.
      await waitForVisualAssets();
      if (revision !== runtimeRevision) continue;
      // Older pages get a bounded grace period for one-shot startup timers.
      if (legacyChecks-- > 0 && Array.from(timers.values()).some(function (timer) { return !timer.repeat; })) continue;
      return;
    }
  }

  function disabledWorker() { throw new Error('interactive-worker-disabled'); }
  try { window.Worker = disabledWorker; } catch (_) {}
  try { window.SharedWorker = disabledWorker; } catch (_) {}

  function post(kind, code, message, requestId, needsTime) {
    var payload = {
      kind: kind,
      code: code,
      message: String(message || '').slice(0, 1200),
      requestId: requestId,
      needsTime: needsTime
    };
    payload[FLAG] = true;
    window.parent.postMessage(payload, '*');
  }

  window.addEventListener('securitypolicyviolation', function (event) {
    // fetch/XHR report a rejected request to the widget. Its fallback can
    // still draw successfully. Unhandled errors go through the error bridge.
    if (event.effectiveDirective === 'connect-src') return;
    post('failure', 'interactive-runtime-failure',
      'Offline capture blocked ' + event.effectiveDirective + ': ' + event.blockedURI);
  });

  function setTimer(fn, delay, args, repeat) {
    if (frozen && !capturing && !runtimes.size) return 0;
    var id = ++timerId;
    var ms = Math.max(repeat ? 16 : 0, Number(delay) || 0);
    var timer = {
      at: sceneTime + ms,
      repeat: repeat ? ms : 0,
      callback: function () {
        if (typeof fn === 'function') fn.apply(window, args);
        else Function(String(fn))();
      }
    };
    function runStartupTimer() {
      if (timer.repeat) timer.handle = nativeSetTimeout(runStartupTimer, ms);
      else timers.delete(id);
      timer.callback();
    }
    if (!frozen) timer.handle = nativeSetTimeout(runStartupTimer, ms);
    timers.set(id, timer);
    return id;
  }
  window.setTimeout = function (fn, delay) {
    return setTimer(fn, delay, Array.prototype.slice.call(arguments, 2), false);
  };
  window.setInterval = function (fn, delay) {
    return setTimer(fn, delay, Array.prototype.slice.call(arguments, 2), true);
  };
  window.clearTimeout = window.clearInterval = function (id) {
    var timer = timers.get(Number(id));
    if (!timer) return;
    nativeClearTimeout(timer.handle);
    timers.delete(Number(id));
  };
  window.requestAnimationFrame = function (fn) {
    if (typeof fn !== 'function') throw new TypeError('Animation frame callback must be a function');
    if (frozen && !capturing && !runtimes.size) return 0;
    var id = ++frameId;
    rafs.set(id, { callback: fn, timed: frozen && !drawingUntimedFrame });
    pumpFrames();
    return id;
  };
  window.cancelAnimationFrame = function (id) { rafs.delete(Number(id)); };

  function waitForImages() {
    return Promise.all(Array.from(document.images || []).map(function (img) {
      if (!img.currentSrc && !img.getAttribute('src') && !img.getAttribute('srcset')) return Promise.resolve();
      if (img.loading === 'lazy') img.loading = 'eager';
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
      if (video.error) return Promise.reject(new Error('interactive-video-load-failure'));
      if (video.readyState >= 2) return Promise.resolve();
      video.preload = 'auto';
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

  function waitForVisualAssets() {
    return Promise.all([waitForImages(), waitForVideos(), document.fonts && document.fonts.ready]);
  }

  function pauseVisuals() {
    Array.from(document.querySelectorAll('video,audio')).forEach(function (media) {
      try { media.pause(); } catch (_) {}
    });
    var active = new Set(document.getAnimations());
    animations.forEach(function (_, animation) {
      if (!active.has(animation)) animations.delete(animation);
    });
    active.forEach(function (animation) {
      if (!animations.has(animation)) animations.set(animation, frozen && capturing ? sceneTime : null);
      if (animation.playState === 'running' || animation.pending) animation.pause();
      var start = animations.get(animation);
      if (start !== null) animation.currentTime = sceneTime - start;
    });
  }

  function freeze() {
    if (frozen) return;
    frozen = true;
    frameOrigin = Math.ceil(browserNow());
    nativeClearTimeout(pumpTimer);
    timers.forEach(function (timer) { nativeClearTimeout(timer.handle); });
    timers.clear();
    var style = document.createElement('style');
    style.setAttribute('data-openmaic-static-frozen', '');
    style.textContent = '*,*::before,*::after{animation-play-state:paused!important;transition:none!important;caret-color:transparent!important}';
    (document.head || document.documentElement).appendChild(style);
    pauseVisuals();
    document.documentElement.setAttribute('data-openmaic-static-state', 'frozen');
  }

  // Timers created by teaching actions (e.g. temporary highlights) use the
  // scene clock, so they expire consistently in direct and sequential seeks.
  function nextTimer() {
    var next;
    timers.forEach(function (timer, id) {
      if (!next || timer.at < next.timer.at) next = { timer: timer, id: id };
    });
    return next;
  }

  async function runDueTimers(remaining) {
    var next;
    while ((next = nextTimer()) && next.timer.at <= sceneTime) {
      if (--remaining < 0) throw new Error('interactive-action-timer-limit');
      var timer = next.timer;
      if (timer.repeat) timer.at += timer.repeat;
      else timers.delete(next.id);
      timer.callback();
      // Native timer callbacks run as separate tasks, each followed by a
      // microtask checkpoint before the next callback observes its state.
      await yieldToBrowser();
    }
    return remaining;
  }

  function scheduleNextFrame() {
    if (!Array.from(rafs.values()).some(function (frame) { return frame.timed; })) {
      nextFrameAt = Infinity;
      return;
    }
    if (nextFrameAt === Infinity) {
      frameStartAt = sceneTime;
      frameNumber = 0;
    }
    // Derive each tick from its origin to avoid accumulated floating-point
    // error delaying callbacks that check an exact elapsed time.
    if (nextFrameAt === Infinity || nextFrameAt <= sceneTime) {
      nextFrameAt = frameStartAt + (++frameNumber * 1000) / 60;
    }
  }

  async function settleChange(immediateFrames, includeUntimedFrames, skipTimedThrough) {
    var remaining = 2000;
    for (;;) {
      remaining = await runDueTimers(remaining);
      if (immediateFrames > 0 && rafs.size) {
        await drawFrame(frameOrigin + sceneTime, includeUntimedFrames, skipTimedThrough);
        immediateFrames--;
        // Render loops queued before freezing may need more passes to show the
        // change. Frames the change requested continue on the scene clock.
        skipTimedThrough = Infinity;
      }
      await waitForVisualAssets();
      var timer = nextTimer();
      if ((timer && timer.timer.at <= sceneTime) || (immediateFrames > 0 && rafs.size)) continue;
      scheduleNextFrame();
      // A pending promise can depend on a future timeline task. Capture the
      // current state and let the next seek run it when its time arrives.
      if (!runtimes.size) break;
      if (!blockingRuntimes && !browserTasks.size && (timer || nextFrameAt !== Infinity)) break;
      await sleep(16);
    }
    pauseVisuals();
  }

  async function advance(time) {
    for (var count = 0; ; count++) {
      var timer = nextTimer();
      var next = Math.min(nextFrameAt, timer ? timer.timer.at : Infinity);
      if (next > time) break;
      sceneTime = next;
      await settleChange(next === nextFrameAt ? 1 : 0, false, 0);
      // A renderer can start in the middle of a scene with many due tasks.
      if (count % 64 === 63) await sleep(0);
    }
    sceneTime = time;
    pauseVisuals();
  }

  window.addEventListener('message', async function (event) {
    var data = event.data;
    if (event.source !== window.parent || !data || data[FLAG] !== true || data.kind !== 'seek' || !frozen || capturing) return;
    capturing = true;
    try {
      for (var action of data.actions) {
        await advance(action.at);
        var priorFrameId = frameId;
        window.dispatchEvent(new MessageEvent('message', { data: action.message, source: event.source, origin: event.origin }));
        await settleChange(3, true, priorFrameId);
      }
      await advance(data.time);
      await sleep(0);
      var hasAnimation = Array.from(animations).some(function (entry) {
        var animation = entry[0];
        return entry[1] !== null && animation.effect && animation.currentTime < animation.effect.getComputedTiming().endTime;
      });
      post('sought', undefined, undefined, data.requestId,
        timers.size > 0 || runtimes.size > 0 || nextFrameAt !== Infinity || hasAnimation);
    } catch (error) {
      post('failure', 'interactive-runtime-failure', error && error.message || error);
    } finally {
      capturing = false;
    }
  });

  window.addEventListener('load', function () {
    var readiness = settleStartup(3);
    var deadlineTimer;
    var deadline = new Promise(function (_, reject) {
      deadlineTimer = nativeSetTimeout(function () { reject(new Error('interactive-readiness-timeout')); }, ${internalTimeoutMs});
    });
    Promise.race([readiness, deadline])
      .then(function () {
        nativeClearTimeout(deadlineTimer);
        freeze();
        post('frozen', 'interactive-static-ready', 'ready');
      })
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
  const fetcher =
    options.fetcher ?? createAssetFetcher({ maxAssetBytes: MAX_VIDEO_CAPTURE_ASSET_BYTES });

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
      const capture = await prepareCaptureAssets(authored, fetcher, maxBytes);
      const {
        html: inlined,
        report,
        unresolved,
      } = await inlineHtmlAssets(capture.html, {
        fetcher,
        baseUrl: options.baseUrl,
        keepImportmapFallbacks: false,
      });
      const sanitized = stripInvalidFontFallbacks(inlined);
      const residual = [
        ...new Set([
          ...report.failed
            .map((failure) => failure.url)
            .filter((url) => !/^about:invalid$/i.test(url)),
          ...unresolved,
          ...capture.offline.unresolved,
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

      const packaged = capture.embedRuntimes(
        injectIntoDocumentHead(
          patchHtmlForIframe(sanitized, undefined, { processed: true }),
          staticCaptureInjection(capture.offline.assets),
        ),
      );
      const bytes = new TextEncoder().encode(packaged);
      const size = bytes.byteLength;
      if (size > maxBytes) {
        bySceneId.set(scene.id, {
          id: assetId,
          present: false,
          failure: 'too-large',
          message: `interactive-html-too-large:${size}/${maxBytes}`,
        });
        continue;
      }

      const contentHash = await sha256BytesHex(bytes);
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
