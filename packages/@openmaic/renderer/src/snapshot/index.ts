'use client';

/**
 * Off-screen Slide → PNG renderer.
 *
 * Mounts the given `Slide` into an off-screen container at its native pixel
 * size, waits for fonts + images to settle, then snapshots the DOM via
 * `html2canvas-pro`. Returns the rendered output as a Blob (default) or a
 * `data:image/png;base64,...` string.
 *
 * Why html2canvas-pro and not html-to-image: the latter uses an SVG
 * `<foreignObject>` + Image decode path. Fonts inside the foreignObject
 * load asynchronously and the snapshot fires before woff2 decode finishes,
 * so text is laid out in the fallback font (visible as different word-wrap
 * positions vs the on-screen canvas). html2canvas-pro walks the DOM and
 * draws to a canvas directly, inheriting the parent document's font
 * registry, so text wraps identically.
 *
 * Use cases: visual regression baselines (compare with the source PPT's
 * own PNG export), user-triggered "export slide as image", CI snapshot
 * jobs. Caller does not need a live `<SlideCanvas>` mounted in the UI.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import html2canvas from 'html2canvas-pro';
import { SlideCanvas } from '../SlideCanvas';
import type { Slide } from '@openmaic/dsl';

export interface SlideToPngOptions {
  /**
   * Output pixel width. Defaults to the slide's native `viewportSize`
   * (e.g. 1280 for a 16:9 widescreen deck). Height is derived from
   * `viewportRatio`.
   */
  width?: number;
  /**
   * Multiplier on output resolution. Default tracks `window.devicePixelRatio`
   * (typically 2 on retina displays) so the exported PNG is as sharp as
   * the on-screen canvas. Pass 1 for a lighter file at the cost of
   * sub-pixel clarity.
   */
  pixelRatio?: number;
  /**
   * Background color filled behind the slide. Defaults to white. Pass
   * 'transparent' to keep the slide's own background only.
   */
  backgroundColor?: string;
  /**
   * Output format. 'blob' yields a `Blob` suitable for `URL.createObjectURL`
   * + download; 'dataUrl' yields a `data:image/png;base64,...` string.
   */
  format?: 'blob' | 'dataUrl';
  /**
   * Settle timeout in milliseconds. The snapshot waits for `document.fonts.ready`
   * and every `<img>` inside the container to load (or error) before
   * capturing — but won't wait longer than this. Defaults to 5000.
   */
  timeoutMs?: number;
  /**
   * Debug only — render the off-screen container on-screen for the given
   * number of milliseconds after snapshot so you can visually confirm what
   * was captured. Do not use in production.
   */
  debugVisibleMs?: number;
}

const DEFAULT_VIEWPORT_RATIO = 0.5625;
const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Render a `Slide` to a PNG image.
 *
 * Throws if called outside a browser (no `document` / `window`), if React
 * fails to mount, or if html2canvas-pro hits a CORS-tainted canvas (cross-
 * origin `<img>` without permissive headers will block the snapshot).
 */
export async function slideToPng(
  slide: Slide,
  options: SlideToPngOptions = {},
): Promise<Blob | string> {
  if (typeof document === 'undefined') {
    throw new Error('slideToPng requires a browser environment');
  }

  const width = options.width ?? slide.viewportSize ?? 1280;
  const viewportRatio = slide.viewportRatio ?? DEFAULT_VIEWPORT_RATIO;
  const height = Math.round(width * viewportRatio);
  const backgroundColor = options.backgroundColor ?? '#ffffff';
  const pixelRatio = options.pixelRatio ?? window.devicePixelRatio ?? 1;
  const format = options.format ?? 'blob';
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const debugVisibleMs = options.debugVisibleMs ?? 0;

  // Off-screen container sized exactly to the slide so SlideCanvas's
  // fit-to-container math collapses to a 1:1 native render (no scale, no
  // centering offset). `position: absolute` (not fixed) + far-left offset
  // keeps the element in layout but out of the viewport; some browsers
  // skip paint for `position: fixed` elements outside the viewport, which
  // breaks the snapshot.
  const container = document.createElement('div');
  container.style.cssText = [
    'position: absolute',
    'left: -99999px',
    'top: 0',
    `width: ${width}px`,
    `height: ${height}px`,
    'pointer-events: none',
    `background-color: ${backgroundColor}`,
  ].join('; ');
  document.body.appendChild(container);

  let root: Root | null = null;
  try {
    root = createRoot(container);
    // flushSync forces the initial commit to happen synchronously instead of
    // being deferred by React 18's scheduler. Without it, the next RAFs can
    // fire before the first render lands and the snapshot captures an empty
    // container.
    flushSync(() => {
      root!.render(createElement(SlideCanvas, { slide, chrome: false }));
    });

    // Give the SlideCanvas's ResizeObserver-driven `useViewportSize` a few
    // frames to fire and write `fitScale`. Default state already paints at
    // 1:1, but waiting avoids a flash of unscaled content when the slide
    // viewportSize differs from the container.
    await nextFrame();
    await nextFrame();

    // Explicitly force-load every (style, weight, family) the slide actually
    // uses BEFORE snapshotting. `document.fonts.ready` alone is racy: it can
    // resolve before the off-screen render has triggered a self-hosted woff2
    // fetch, so html2canvas captures a fallback face. For mixed CJK+Latin text
    // the fallback's Latin/digit advance widths differ from the intended font,
    // shifting number/English runs (seen on cold single-slide exports). Loading
    // each face up front makes the capture deterministic regardless of warmup.
    if (document.fonts && typeof document.fonts.load === 'function') {
      const fontSpecs = new Set<string>();
      container.querySelectorAll<HTMLElement>('*').forEach((el) => {
        if (!el.textContent || !el.textContent.trim()) return;
        const cs = getComputedStyle(el);
        if (!cs.fontFamily) return;
        fontSpecs.add(`${cs.fontStyle} ${cs.fontWeight} 16px ${cs.fontFamily}`);
      });
      await Promise.race([
        Promise.all([...fontSpecs].map((spec) => document.fonts.load(spec).catch(() => undefined))),
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }

    await Promise.race([
      Promise.all([
        document.fonts ? document.fonts.ready : Promise.resolve(),
        ...Array.from(container.querySelectorAll('img')).map((img) => {
          if (img.complete && img.naturalWidth > 0) return Promise.resolve();
          return new Promise<void>((resolve) => {
            const done = () => resolve();
            img.addEventListener('load', done, { once: true });
            img.addEventListener('error', done, { once: true });
          });
        }),
      ]),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);

    // html2canvas-pro can't draw <video> elements (it ignores the `poster`
    // attribute and renders nothing for an undecoded source), so a video that
    // shows fine on the live canvas comes out白板 in the PNG. Convert every
    // <video> in the throwaway off-screen tree into an <img> of its poster
    // (or current decoded frame) BEFORE the snapshot so html2canvas captures
    // the same preview frame the canvas shows.
    await Promise.all(
      Array.from(container.querySelectorAll('video')).map((video) => replaceVideoWithFrame(video)),
    );

    // html2canvas-pro doesn't implement CSS `filter` functions (brightness /
    // contrast / saturate / opacity etc.), so PowerPoint picture corrections —
    // washout via <a:lum bright/contrast> and transparency via <a:alphaModFix>
    // — show on the live canvas but vanish from the exported PNG (the image
    // comes out fully saturated/opaque). Bake each filtered <img> into its
    // pixels with a Canvas2D pass (ctx.filter, which Chrome does support)
    // BEFORE the snapshot so html2canvas captures the corrected bitmap.
    await Promise.all(
      Array.from(container.querySelectorAll('img')).map((img) => bakeImageFilter(img)),
    );

    // html2canvas-pro also ignores CSS masks, so the soft-edge feather
    // (a:softEdge) set by BaseImageElement vanishes from the PNG. Bake the same
    // feather (two destination-in alpha gradients) into the pixels.
    await Promise.all(
      Array.from(container.querySelectorAll<HTMLImageElement>('img[data-soft-edge]')).map((img) =>
        bakeImageSoftEdge(img),
      ),
    );

    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.debug('[slideToPng] container ready', {
        innerHTMLLength: container.innerHTML.length,
        imgCount: container.querySelectorAll('img').length,
        size: `${width}x${height}`,
      });
    }

    // Target the inner SlideCanvas root so html2canvas-pro's bounding-box
    // calculation matches the slide exactly (otherwise the outer container's
    // padding/margin assumptions can leave white edges).
    const target = (container.firstElementChild as HTMLElement | null) ?? container;

    const canvas = await html2canvas(target, {
      backgroundColor,
      width,
      height,
      scale: pixelRatio,
      useCORS: true,
      // Skip walking the page's stylesheets; the cloned DOM already inherits
      // computed styles. This also avoids CORS errors when the document has
      // cross-origin stylesheets.
      foreignObjectRendering: false,
      logging: false,
      // html2canvas-pro's CJK text measurement can mis-position full-width
      // punctuation (e.g. `（`/`）` get pushed past the cell boundary and
      // appear clipped). Force neutral kerning + feature settings on the
      // cloned tree so each glyph advances at its natural width.
      onclone: (clonedDoc) => {
        const style = clonedDoc.createElement('style');
        style.textContent = `
          .slide-renderer-cell-text,
          .slide-renderer-cell-text *,
          .slide-renderer-prose,
          .slide-renderer-prose * {
            font-kerning: none !important;
            font-feature-settings: normal !important;
            font-variant-east-asian: normal !important;
            text-rendering: geometricPrecision !important;
          }
        `;
        clonedDoc.head.appendChild(style);
      },
    });

    if (format === 'blob') {
      return await canvasToBlob(canvas);
    }
    return canvas.toDataURL('image/png');
  } finally {
    if (debugVisibleMs > 0) {
      // Temporarily show the container on-screen so the caller can compare
      // what was captured vs the on-page render.
      container.style.left = '0';
      container.style.top = '0';
      container.style.zIndex = '99999';
      container.style.border = '4px dashed magenta';
      await new Promise((r) => setTimeout(r, debugVisibleMs));
    }
    // Defer unmount one tick so React doesn't warn about unmounting during
    // a commit phase (the html2canvas promise can still be mid-render in
    // dev mode).
    if (root) {
      const r = root;
      setTimeout(() => r.unmount(), 0);
    }
    setTimeout(() => container.remove(), 0);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Replace a <video> with an <img> showing its poster (or, if no poster is set,
 * its current decoded frame drawn onto a canvas). Copies the video's inline
 * style so layout is unchanged, then waits for the <img> to load so the
 * subsequent html2canvas pass captures it. No-ops if there's nothing to draw.
 */
async function replaceVideoWithFrame(video: HTMLVideoElement): Promise<void> {
  const parent = video.parentElement;
  if (!parent) return;

  let imgSrc: string | null = video.poster || video.getAttribute('poster') || null;

  // No poster but the source decoded → grab the current frame.
  if (!imgSrc && video.readyState >= 2 && video.videoWidth > 0) {
    try {
      const frame = document.createElement('canvas');
      frame.width = video.videoWidth;
      frame.height = video.videoHeight;
      frame.getContext('2d')?.drawImage(video, 0, 0);
      imgSrc = frame.toDataURL('image/png');
    } catch {
      // CORS-tainted frame — leave imgSrc null and bail below.
    }
  }
  if (!imgSrc) return;

  const img = document.createElement('img');
  img.src = imgSrc;
  img.style.cssText = video.style.cssText;
  if (!img.style.width) img.style.width = '100%';
  if (!img.style.height) img.style.height = '100%';
  if (!img.style.objectFit) img.style.objectFit = 'contain';

  await new Promise<void>((resolve) => {
    if (img.complete && img.naturalWidth > 0) return resolve();
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  });

  parent.replaceChild(img, video);
}

/**
 * Bake an <img>'s CSS `filter` into its bitmap. html2canvas-pro ignores the
 * `filter` property, so without this any brightness/contrast/saturate/opacity
 * applied by the renderer (PPT lum/alphaModFix corrections) is lost in the PNG.
 * Draws the image through a Canvas2D `ctx.filter` pass, swaps the src for the
 * baked PNG, and clears the inline filter so the value isn't double-applied.
 * No-ops when there's no filter, the image hasn't decoded, or the canvas is
 * CORS-tainted (export would throw — leave the original img untouched).
 */
async function bakeImageFilter(img: HTMLImageElement): Promise<void> {
  const filter = (img.style.filter || '').trim();
  if (!filter || filter === 'none') return;
  if (!img.complete || img.naturalWidth === 0) return;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.filter = filter;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const baked = canvas.toDataURL('image/png');

    img.style.filter = '';
    await new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
      img.src = baked;
    });
  } catch {
    // CORS-tainted source or unsupported ctx.filter — keep the original <img>.
  }
}

/**
 * Bake the soft-edge feather (a:softEdge) into an <img>'s bitmap. html2canvas-pro
 * ignores CSS masks, so the feather BaseImageElement applies is lost in the PNG.
 * The feather radius is read from `data-soft-edge` (px in the element's displayed
 * box) and scaled to the image's natural pixels. Two `destination-in` linear
 * gradient passes multiply the alpha down to 0 within `r` of each edge (corners
 * get both axes), matching the live CSS mask. No-ops on undecoded/ CORS-tainted
 * images or zero radius.
 */
async function bakeImageSoftEdge(img: HTMLImageElement): Promise<void> {
  const rCss = parseFloat(img.dataset.softEdge || '');
  if (!rCss || rCss <= 0) return;
  if (!img.complete || img.naturalWidth === 0) return;

  const displayedW = img.offsetWidth || img.naturalWidth;
  const scale = img.naturalWidth / displayedW;
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const r = Math.min(rCss * scale, w / 2, h / 2);
  if (r <= 0) return;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, 0, 0, w, h);
    ctx.globalCompositeOperation = 'destination-in';

    const stops = (g: CanvasGradient, extent: number) => {
      const f = r / extent;
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(f, 'rgba(0,0,0,1)');
      g.addColorStop(1 - f, 'rgba(0,0,0,1)');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      return g;
    };
    const gh = stops(ctx.createLinearGradient(0, 0, w, 0), w);
    ctx.fillStyle = gh;
    ctx.fillRect(0, 0, w, h);
    const gv = stops(ctx.createLinearGradient(0, 0, 0, h), h);
    ctx.fillStyle = gv;
    ctx.fillRect(0, 0, w, h);

    const baked = canvas.toDataURL('image/png');
    img.removeAttribute('data-soft-edge');
    img.style.maskImage = '';
    (img.style as unknown as Record<string, string>).webkitMaskImage = '';
    await new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
      img.src = baked;
    });
  } catch {
    // CORS-tainted source — keep the original <img>.
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('slideToPng: canvas.toBlob returned null'));
    }, 'image/png');
  });
}
