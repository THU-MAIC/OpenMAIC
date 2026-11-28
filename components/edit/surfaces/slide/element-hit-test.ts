/**
 * Canvas element hit-testing and measurement — the DOM half of element picking,
 * shared by the cue picker, the lasso picker and the reference pin layer.
 *
 * Two things differ between hosts:
 *
 * 1. WHICH attribute names an element. The `@openmaic/editor` package emits
 *    `data-element-id` / `data-select-element-id` / `data-context-element-id`;
 *    app-owned hosts such as the whiteboard stamp the renderer-agnostic
 *    `data-maic-element-id`. The hit-test accepts all of them.
 *
 * 2. WHICH node carries the geometry. The `#editable-element-{id}` /
 *    `#screen-element-{id}` host is a full-canvas or zero-size wrapper (it
 *    holds a z-index). The painted box is the renderer's
 *    `.slide-element-hit-target > .base-element-*`, or `.element-content` in a
 *    host without that structure. Measuring the wrapper collapses every outline
 *    to a 0×0 rect at the canvas origin.
 */
import {
  MAIC_ELEMENT_ID_ATTRIBUTE,
  editableElementDomId,
  screenElementDomId,
} from './renderer-element-dom';

/**
 * Element-id attributes a hit-test accepts, most specific first. The app's own
 * marker leads: when both are present they agree, and when only one is, the
 * walk finds it either way.
 */
export const INTERACTION_ELEMENT_ID_ATTRIBUTES = [
  MAIC_ELEMENT_ID_ATTRIBUTE,
  'data-element-id',
  'data-select-element-id',
  'data-context-element-id',
] as const;

const INTERACTION_SELECTOR = INTERACTION_ELEMENT_ID_ATTRIBUTES.map(
  (attribute) => `[${attribute}]`,
).join(',');

/** The element id painted at these viewport coordinates, if any. */
export function elementIdAtPoint(x: number, y: number): string | null {
  for (const node of document.elementsFromPoint(x, y)) {
    const target = (node as HTMLElement).closest?.(INTERACTION_SELECTOR) as HTMLElement | null;
    if (!target) continue;
    for (const attribute of INTERACTION_ELEMENT_ID_ATTRIBUTES) {
      const id = target.getAttribute(attribute);
      if (id) return id;
    }
  }
  return null;
}

/** The element's host wrapper, in whichever renderer currently owns the canvas. */
export function elementHostNode(elementId: string): HTMLElement | null {
  return (
    document.getElementById(editableElementDomId(elementId)) ??
    document.getElementById(screenElementDomId(elementId))
  );
}

/**
 * The node whose box IS the element on screen. Falls back through the two
 * renderer shapes and finally to the host itself, so a caller always gets
 * something measurable rather than silently rendering nothing.
 */
export function elementPaintNode(elementId: string): HTMLElement | null {
  const host = elementHostNode(elementId);
  if (!host) return null;
  return (
    host.querySelector<HTMLElement>(
      '.slide-element-hit-target > [class^="base-element-"], .slide-element-hit-target > [class*=" base-element-"]',
    ) ??
    host.querySelector<HTMLElement>('.element-content') ??
    host
  );
}

export interface CanvasBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A viewport rect expressed relative to a canvas-local container. */
export function toCanvasBox(rect: DOMRect, container: HTMLElement | null): CanvasBox | null {
  const origin = container?.getBoundingClientRect();
  if (!origin) return null;
  return {
    left: rect.left - origin.left,
    top: rect.top - origin.top,
    width: rect.width,
    height: rect.height,
  };
}

/** Measure one element against a canvas-local container. */
export function measureElementBox(
  elementId: string,
  container: HTMLElement | null,
): CanvasBox | null {
  const paint = elementPaintNode(elementId);
  if (!paint) return null;
  return toCanvasBox(paint.getBoundingClientRect(), container);
}
