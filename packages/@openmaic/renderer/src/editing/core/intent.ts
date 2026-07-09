import type { EditIntent } from '../types';

/**
 * Build the `element.update` intent for a completed move gesture: the host
 * applies `props` (the element's new `left`/`top`) and owns undo. Pure
 * construction — no React, no store, no `@/` imports.
 */
export function moveIntent(id: string, props: { left: number; top: number }): EditIntent {
  return { type: 'element.update', id, props };
}

/**
 * Build the `element.update` intent for a completed resize gesture: the box
 * props only (`left`/`top`/`width`/`height`). Kind-specific content that must
 * track the box (a shape's path/viewBox, a table's `cellMinHeight`, an image's
 * clip mode) is intentionally NOT recomputed here — the host can post-process
 * in response to the intent, or a later slice moves that math into the package.
 */
export function resizeIntent(
  id: string,
  props: { left: number; top: number; width: number; height: number },
): EditIntent {
  return { type: 'element.update', id, props };
}

/** Build the `element.update` intent for a completed rotate gesture. */
export function rotateIntent(id: string, rotate: number): EditIntent {
  return { type: 'element.update', id, props: { rotate } };
}
