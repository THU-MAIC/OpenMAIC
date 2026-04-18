/**
 * CourseVideoRecorder
 *
 * Owns the low-level recording pipeline:
 *   html2canvas  →  offscreen <canvas>  →  captureStream(STREAM_FPS)  →  MediaRecorder
 *   AudioContext →  MediaStreamDestination                             →  MediaRecorder
 *
 * Design decisions
 * ────────────────
 * • captureStream(STREAM_FPS) (not 0): the browser samples the canvas at a fixed
 *   rate. Manual requestFrame() with captureStream(0) proved unreliable in practice —
 *   frames were silently dropped by the encoder.
 * • Double requestAnimationFrame before each html2canvas call: ensures React has
 *   committed and the browser has painted the current state before we snapshot.
 *   Without this the frame loop blocks React and the UI freezes.
 * • Static segments (speech + TTS): capture once (or twice), then hold — the stream
 *   repeats the last canvas pixels until the next capture.
 * • Pointer animations (spotlight / laser): captureFor uses wall-clock–synced slots
 *   at CAPTURE_FOR_TARGET_FPS so samples align with CSS animation time as well as
 *   html2canvas latency allows.
 */

import html2canvas from 'html2canvas';
import { createLogger } from '@/lib/logger';

const log = createLogger('CourseVideoRecorder');

const VIDEO_WIDTH = 1920;
const VIDEO_HEIGHT = 1080;

/** Canvas sampling rate for MediaRecorder (video track). */
const STREAM_FPS = 60;

/**
 * Target sample rate for spotlight / laser only — wall-clock slots so captures line
 * up with animation time better than a fixed post-capture sleep.
 */
const CAPTURE_FOR_TARGET_FPS = 12;

/** 1080p WebM: explicit bitrate avoids mushy defaults and weak first-second quality. */
const VIDEO_BITS_PER_SECOND = 10_000_000;
const AUDIO_BITS_PER_SECOND = 160_000;

/**
 * Preferred mime types, ordered so VP9/WebM comes first.
 * VP9 + WebM works reliably with CanvasCaptureMediaStream; H264/MP4 can
 * produce an empty video track depending on Chrome version.
 */
const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
  'video/mp4;codecs=h264,aac',
  'video/mp4',
];

function chooseMimeType(): string {
  for (const mime of MIME_CANDIDATES) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      log.debug('Chosen mime type:', mime);
      return mime;
    }
  }
  return '';
}

/**
 * Prefer explicit video/audio bitrates; fall back if the browser rejects the options
 * object (some mime combos ignore or throw on unknown fields).
 */
function createMediaRecorder(stream: MediaStream, mimeType: string): MediaRecorder {
  const candidates: MediaRecorderOptions[] = [
    ...(mimeType
      ? [
          {
            mimeType,
            videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
            audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
          },
          { mimeType, videoBitsPerSecond: VIDEO_BITS_PER_SECOND },
          { mimeType },
        ]
      : [
          {
            videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
            audioBitsPerSecond: AUDIO_BITS_PER_SECOND,
          },
          { videoBitsPerSecond: VIDEO_BITS_PER_SECOND },
        ]),
    {},
  ];
  for (const opts of candidates) {
    try {
      const keys = Object.keys(opts) as (keyof MediaRecorderOptions)[];
      if (keys.length === 0) return new MediaRecorder(stream);
      return new MediaRecorder(stream, opts);
    } catch {
      /* try next */
    }
  }
  return new MediaRecorder(stream);
}

/**
 * html2canvas 1.4.x cannot parse modern CSS color functions (`oklab`, `oklch`,
 * `color(display-p3 …)`). Tailwind v4 / Geist emit those in stylesheets, which
 * makes every capture throw and leaves the recording canvas blank.
 *
 * Fix: on the cloned document html2canvas builds, strip linked stylesheets and
 * `<style>` tags, then copy resolved used values from the **live** DOM onto
 * inline `style` on each cloned node. Browsers serialize computed colors as
 * `rgb()` / `rgba()` in almost all cases, which html2canvas accepts.
 */
const INLINABLE_CSS_PROPS: readonly string[] = [
  'display',
  'position',
  'top',
  'left',
  'right',
  'bottom',
  'width',
  'height',
  'max-width',
  'max-height',
  'min-width',
  'min-height',
  'margin-top',
  'margin-right',
  'margin-bottom',
  'margin-left',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'border-top-style',
  'border-right-style',
  'border-bottom-style',
  'border-left-style',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-radius',
  'border-top-left-radius',
  'border-top-right-radius',
  'border-bottom-right-radius',
  'border-bottom-left-radius',
  'box-sizing',
  'overflow',
  'overflow-x',
  'overflow-y',
  'background-color',
  'background-image',
  'background-size',
  'background-position',
  'background-repeat',
  'color',
  'opacity',
  'visibility',
  'font-family',
  'font-size',
  'font-weight',
  'font-style',
  'line-height',
  'letter-spacing',
  'text-align',
  'text-decoration',
  'text-transform',
  'white-space',
  'word-break',
  'flex',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-items',
  'align-self',
  'align-content',
  'justify-content',
  'justify-items',
  'gap',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column-start',
  'grid-column-end',
  'grid-row-start',
  'grid-row-end',
  'transform',
  'transform-origin',
  'z-index',
  'pointer-events',
  'box-shadow',
  'filter',
  'backdrop-filter',
  'object-fit',
  'object-position',
];

/**
 * html2canvas 1.4.x rejects many CSS Color 4/5 functions (`lab`, `lch`, `oklab`, …).
 * Browsers often serialize `getComputedStyle()` as `lab()` / `lch()` — those must
 * not be copied onto the clone or html2canvas throws before painting.
 */
function cssValueSafeForHtml2Canvas(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (!v) return true;
  if (v.includes('lab(') || v.includes('lch(')) return false;
  if (v.includes('oklab') || v.includes('oklch')) return false;
  if (v.includes('hwb(')) return false;
  if (v.includes('color-mix(')) return false;
  if (v.includes('device-cmyk(')) return false;
  if (v.includes('display-p3')) return false;
  return true;
}

function stripUnsupportedStylesheets(clonedDoc: Document): void {
  clonedDoc.querySelectorAll('link[rel="stylesheet"], link[rel=preload][as="style"]').forEach((n) => {
    n.parentNode?.removeChild(n);
  });
  clonedDoc.querySelectorAll('style').forEach((n) => {
    n.parentNode?.removeChild(n);
  });
}

/** Remove inline attributes that still contain unsupported color syntax (cloned from live DOM). */
function stripUnsafePaintAttributesFromCloneTree(clonedDoc: Document): void {
  clonedDoc.querySelectorAll('[style]').forEach((el) => {
    const s = el.getAttribute('style') ?? '';
    if (s && !cssValueSafeForHtml2Canvas(s)) el.removeAttribute('style');
  });
  clonedDoc.querySelectorAll('[fill], [stroke], [stop-color]').forEach((el) => {
    for (const attr of ['fill', 'stroke', 'stop-color'] as const) {
      const v = el.getAttribute(attr);
      if (v && !cssValueSafeForHtml2Canvas(v)) el.removeAttribute(attr);
    }
  });
}

function inlineComputedStylesFromLiveDom(orig: Element, clone: Element): void {
  if (orig.nodeType !== Node.ELEMENT_NODE || clone.nodeType !== Node.ELEMENT_NODE) return;

  if (orig instanceof HTMLElement && clone instanceof HTMLElement) {
    clone.removeAttribute('class');
    clone.removeAttribute('style');
    const cs = getComputedStyle(orig);
    const parts: string[] = [];
    for (const prop of INLINABLE_CSS_PROPS) {
      const raw = cs.getPropertyValue(prop).trim();
      if (!raw || raw === 'none' || raw === 'auto') continue;
      if (!cssValueSafeForHtml2Canvas(raw)) continue;
      parts.push(`${prop}: ${raw}`);
    }
    if (parts.length) clone.setAttribute('style', parts.join('; ') + ';');
  }

  if (orig instanceof SVGElement && clone instanceof SVGElement) {
    try {
      const cs = getComputedStyle(orig);
      for (const [attr, prop] of [
        ['fill', 'fill'],
        ['stroke', 'stroke'],
        ['stroke-width', 'stroke-width'],
        ['opacity', 'opacity'],
        ['stop-color', 'stop-color'],
        ['flood-color', 'flood-color'],
        ['lighting-color', 'lighting-color'],
      ] as const) {
        const raw = cs.getPropertyValue(prop).trim();
        if (raw && cssValueSafeForHtml2Canvas(raw)) clone.setAttribute(attr, raw);
      }
    } catch {
      /* ignore */
    }
  }

  const oc = orig.children;
  const cc = clone.children;
  const n = Math.min(oc.length, cc.length);
  for (let i = 0; i < n; i++) inlineComputedStylesFromLiveDom(oc[i], cc[i]);
}

function prepareClonedDomForHtml2Canvas(
  clonedDoc: Document,
  originalRoot: HTMLElement,
  clonedRoot: HTMLElement,
): void {
  stripUnsupportedStylesheets(clonedDoc);
  stripUnsafePaintAttributesFromCloneTree(clonedDoc);
  inlineComputedStylesFromLiveDom(originalRoot, clonedRoot);
}

export class CourseVideoRecorder {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly audioCtx: AudioContext;
  private readonly audioDest: MediaStreamAudioDestinationNode;
  private readonly mediaRecorder: MediaRecorder;
  private readonly chunks: Blob[] = [];
  private readonly mimeType: string;
  private cancelled = false;

  constructor() {
    // Offscreen canvas — not attached to the DOM
    this.canvas = document.createElement('canvas');
    this.canvas.width = VIDEO_WIDTH;
    this.canvas.height = VIDEO_HEIGHT;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('CourseVideoRecorder: could not get 2D context');
    this.ctx = ctx;
    // High-quality upscale from html2canvas snapshots to 1920×1080 (slides are mostly vector/UI).
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Fill with white so the first frame is never black
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);

    // Auto-capture at STREAM_FPS — canvas updates from captureFrame(); the encoder samples the surface.
    const videoStream = this.canvas.captureStream(STREAM_FPS);

    // Audio pipeline
    this.audioCtx = new AudioContext();
    this.audioDest = this.audioCtx.createMediaStreamDestination();

    // Combine video + audio tracks
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...this.audioDest.stream.getAudioTracks(),
    ]);

    this.mimeType = chooseMimeType();

    this.mediaRecorder = createMediaRecorder(combined, this.mimeType);
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
  }

  /** Begin recording */
  start(): void {
    this.mediaRecorder.start(1000);
    log.debug('MediaRecorder started, mime:', this.mimeType);
  }

  /**
   * Signal all capture loops to exit without discarding recorded data.
   * Call `stop()` afterwards to finalise and download the partial video.
   */
  requestAbort(): void {
    this.cancelled = true;
  }

  /**
   * Hard-cancel: stops MediaRecorder and discards all data.
   * Only use this on unrecoverable errors.
   */
  cancel(): void {
    this.cancelled = true;
    try { this.mediaRecorder.stop(); } catch { /* already stopped */ }
    this.audioCtx.close().catch(() => {});
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Snapshot `el` with html2canvas and paint it onto the recording canvas.
   *
   * A double requestAnimationFrame yield runs before the snapshot so React has
   * committed its pending state updates and the browser has painted the DOM.
   * Without this yield the tight capture loop prevents React re-renders entirely.
   */
  async captureFrame(el: HTMLElement, timeLabel?: string): Promise<void> {
    if (this.cancelled) return;

    // Yield two frames: first rAF lets React flush, second ensures the browser
    // has actually painted the updated DOM before html2canvas reads it.
    await raf();
    await raf();

    if (this.cancelled) return;

    const w = Math.max(el.offsetWidth, 1);
    const h = Math.max(el.offsetHeight, 1);

    try {
      const snapshot = await html2canvas(el, {
        useCORS: true,
        allowTaint: true,
        logging: false,
        // Scale so the output always fills VIDEO_WIDTH × VIDEO_HEIGHT
        scale: VIDEO_WIDTH / w,
        width: w,
        height: h,
        backgroundColor: '#ffffff',
        // Ignore elements that html2canvas can't handle (iframes, videos)
        ignoreElements: (node) =>
          node.tagName === 'IFRAME' ||
          (node.tagName === 'VIDEO' && !!(node as HTMLVideoElement).src),
        onclone: (clonedDoc, clonedRoot) => {
          if (clonedRoot instanceof HTMLElement) {
            prepareClonedDomForHtml2Canvas(clonedDoc, el, clonedRoot);
          }
        },
      });

      this.ctx.clearRect(0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
      this.ctx.drawImage(snapshot, 0, 0, VIDEO_WIDTH, VIDEO_HEIGHT);
    } catch (err) {
      log.warn('html2canvas error — using last frame:', err);
      // Leave whatever was already on the canvas rather than going black
    }

    if (timeLabel) this.drawTimeLabel(timeLabel);
    // captureStream(STREAM_FPS) picks up the updated canvas automatically
  }

  /**
   * Repeatedly capture frames for `durationMs` milliseconds (spotlight / laser only).
   * Uses wall-clock slots at CAPTURE_FOR_TARGET_FPS so each sample targets a predictable
   * animation phase; long html2canvas runs skip sleep and continue from the next slot.
   */
  async captureFor(el: HTMLElement, durationMs: number, timeLabel?: string): Promise<void> {
    const slotMs = 1000 / CAPTURE_FOR_TARGET_FPS;
    const start = Date.now();
    const deadline = start + durationMs;
    let frameIndex = 0;
    while (!this.cancelled && Date.now() < deadline) {
      const idealTime = start + frameIndex * slotMs;
      const nowBefore = Date.now();
      if (nowBefore < idealTime) {
        await sleep(Math.min(idealTime - nowBefore, deadline - nowBefore));
      }
      if (this.cancelled || Date.now() >= deadline) break;

      await this.captureFrame(el, timeLabel);
      frameIndex += 1;
    }
  }

  /**
   * Play an audio blob through the AudioContext routed into the recording.
   * Resolves when playback ends.  Audio is NOT sent to speakers — only to the
   * MediaRecorder's audio track.
   */
  async playAudio(blob: Blob): Promise<void> {
    if (this.cancelled) return;

    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await this.audioCtx.decodeAudioData(arrayBuffer);

    return new Promise((resolve) => {
      const source = this.audioCtx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(this.audioDest);
      source.onended = () => resolve();
      source.start(0);
    });
  }

  /** Finalise the recording and return the complete video Blob. */
  stop(): Promise<Blob> {
    return new Promise((resolve, reject) => {
      this.mediaRecorder.onstop = () => {
        // Output as webm even if the filename will be .mp4 — browsers handle it
        const mimeOut = this.mimeType || 'video/webm';
        const blob = new Blob(this.chunks, { type: mimeOut });
        log.debug('Recording complete — size:', blob.size, 'type:', mimeOut);
        this.audioCtx.close().catch(() => {});
        resolve(blob);
      };
      this.mediaRecorder.onerror = (e) => {
        this.audioCtx.close().catch(() => {});
        reject(e);
      };
      try {
        this.mediaRecorder.stop();
      } catch (err) {
        reject(err);
      }
    });
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private drawTimeLabel(label: string): void {
    const padding = 8;
    const fontSize = 14;
    this.ctx.save();
    this.ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
    const metrics = this.ctx.measureText(label);
    const boxW = metrics.width + padding * 2 + 4;
    const boxH = fontSize + padding * 2;

    this.ctx.fillStyle = 'rgba(0,0,0,0.50)';
    roundRect(this.ctx, 14, 14, boxW, boxH, 7);
    this.ctx.fill();

    this.ctx.fillStyle = '#ffffff';
    this.ctx.textBaseline = 'top';
    this.ctx.fillText(label, 14 + padding + 2, 14 + padding);
    this.ctx.restore();
  }
}

// ── Exports ────────────────────────────────────────────────────────────────

/** Trigger a browser file download for a Blob */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

// ── Utilities ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Yield one animation frame — lets React flush pending renders */
function raf(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
