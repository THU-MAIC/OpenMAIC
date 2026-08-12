'use client';

/**
 * Off-screen element-geometry measurement.
 *
 * The video-export compiler places spotlight/laser/video effects on a slide
 * element's geometry. Its pure fallback ({@link ../geometry}) reads the
 * element's *authored* `left/top/width/height` against a fixed 1000×562.5 base
 * — the element's **outer box**. But the live overlays (and the exported frame
 * PNG) measure the element's `.element-content` box, which differs for
 * auto-sized text (`height:auto`) and its 10px content padding, so a spotlight
 * on the authored box sits offset from the rendered text (issue #867 item 5).
 *
 * This measures the same content box the live `SpotlightOverlay` does: it mounts
 * the slide off-screen at native size (the same 1:1 mount `slideToPng` uses),
 * then for each requested element id reads `.element-content`'s
 * `getBoundingClientRect()` normalized against the canvas container rect → 0–100
 * space. The app feeds the result to the compiler as a `GeometryProbe` so the
 * IR carries rendered geometry; the compile stays pure and falls back to the
 * authored box for anything not measured.
 *
 * App-side / impure: needs a browser (DOM + layout). Mirrors `slideToPng`'s
 * mount lifecycle.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SlideCanvas } from '../SlideCanvas';
import type { Slide } from '@openmaic/dsl';

/** Percentage geometry (0–100) — mirrors the compiler's `PercentageGeometry`. */
export interface MeasuredGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  centerX: number;
  centerY: number;
}

export interface MeasureOptions {
  /**
   * Off-screen render width in px. Defaults to the slide's native
   * `viewportSize`. Only the *ratio* of element box to container matters for the
   * 0–100 normalization, so the absolute width is not important — but rendering
   * near native size keeps text wrapping (hence auto-height) faithful.
   */
  width?: number;
  /** Settle timeout in ms for `document.fonts.ready`. Default 5000. */
  timeoutMs?: number;
}

const DEFAULT_VIEWPORT_RATIO = 0.5625;
const DEFAULT_TIMEOUT_MS = 5000;
/** SlideElement renders each element wrapper as `slide-element-<id>` by default. */
const ELEMENT_ID_PREFIX = 'slide-element-';

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

/**
 * Measure the rendered content-box geometry (0–100) of the given element ids on
 * a slide. Returns a Map keyed by element id; ids that could not be located are
 * absent (the caller falls back to the authored-box calc). Never throws for a
 * missing element — only for a non-browser environment.
 *
 * The measurement matches `SpotlightOverlay`: prefer the element's
 * `.element-content` box, else the element wrapper, normalized against the
 * SlideCanvas inner container so it is independent of the off-screen scale.
 */
export async function measureSlideElementGeometry(
  slide: Slide,
  elementIds: readonly string[],
  options: MeasureOptions = {},
): Promise<Map<string, MeasuredGeometry>> {
  const result = new Map<string, MeasuredGeometry>();
  if (typeof document === 'undefined') {
    throw new Error('measureSlideElementGeometry requires a browser environment');
  }
  const ids = [...new Set(elementIds)].filter(Boolean);
  if (ids.length === 0) return result;

  const width = options.width ?? slide.viewportSize ?? 1280;
  const viewportRatio = slide.viewportRatio ?? DEFAULT_VIEWPORT_RATIO;
  const height = Math.round(width * viewportRatio);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const container = document.createElement('div');
  container.style.cssText = [
    'position: absolute',
    'left: -99999px',
    'top: 0',
    `width: ${width}px`,
    `height: ${height}px`,
    'pointer-events: none',
  ].join('; ');
  document.body.appendChild(container);

  let root: Root | null = null;
  try {
    root = createRoot(container);
    flushSync(() => {
      root!.render(createElement(SlideCanvas, { slide, chrome: false }));
    });

    // Let the ResizeObserver-driven fit settle, then settle fonts before we read
    // rects. Auto-height text only reaches its final extent once the real faces
    // load, and `document.fonts.ready` alone is racy — it can resolve before the
    // off-screen render triggers a self-hosted woff2 fetch, leaving a fallback
    // face whose Latin/digit advances differ and shift the measured content box.
    // So force-load every (style, weight, family) actually used first (mirrors
    // `slideToPng`), then await readiness, capped by the settle timeout.
    await nextFrame();
    await nextFrame();
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
    if (document.fonts?.ready) {
      await Promise.race([
        document.fonts.ready,
        new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
      ]);
    }
    // Let any font-triggered relayout settle (KaTeX re-fits once KaTeX_Size loads,
    // a React state update) before reading rects — two frames to commit.
    await nextFrame();
    await nextFrame();

    // The SlideCanvas inner container is the positioned box every element is
    // absolute within; normalizing against it (not the outer offscreen div)
    // makes the geometry independent of the fit scale — exactly what
    // SpotlightOverlay does against its own `inset:0` container.
    const canvasEl = (container.firstElementChild as HTMLElement | null) ?? container;
    const containerRect = canvasEl.getBoundingClientRect();
    if (containerRect.width === 0 || containerRect.height === 0) return result;

    for (const id of ids) {
      const el = container.querySelector<HTMLElement>(`#${cssEscape(ELEMENT_ID_PREFIX + id)}`);
      if (!el) continue;
      const contentEl = el.querySelector<HTMLElement>('.element-content');
      const targetEl = contentEl ?? el;
      const r = targetEl.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      const x = ((r.left - containerRect.left) / containerRect.width) * 100;
      const y = ((r.top - containerRect.top) / containerRect.height) * 100;
      const w = (r.width / containerRect.width) * 100;
      const h = (r.height / containerRect.height) * 100;
      result.set(id, { x, y, w, h, centerX: x + w / 2, centerY: y + h / 2 });
    }
  } finally {
    if (root) {
      const r = root;
      setTimeout(() => r.unmount(), 0);
    }
    setTimeout(() => container.remove(), 0);
  }

  return result;
}

/** Minimal CSS.escape fallback for element ids used in a selector. */
function cssEscape(value: string): string {
  const g = globalThis as { CSS?: { escape?: (v: string) => string } };
  if (g.CSS?.escape) return g.CSS.escape(value);
  // Escape characters that are not safe in a CSS identifier.
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
