'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export interface TrackedToolbarRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

function equalRects(left: TrackedToolbarRect | null, right: TrackedToolbarRect | null) {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.left === right.left &&
      left.top === right.top &&
      left.width === right.width &&
      left.height === right.height)
  );
}

/** Keep a floating toolbar clear of the selected element's interactive rotation handle. */
export function measureEditorToolbarAnchor(node: Element, elementId: string): TrackedToolbarRect {
  const rect = node.getBoundingClientRect();
  const handle = node
    .closest('[data-editable-slide-canvas]')
    ?.querySelector<HTMLElement>('[data-rotate-handle]');
  if (handle?.dataset.rotateElementId !== elementId) return rect;
  const knob = handle.getBoundingClientRect();
  const top = Math.min(rect.top, knob.top);
  return {
    left: rect.left,
    width: rect.width,
    top,
    height: Math.max(rect.bottom, knob.bottom) - top,
  };
}

function getAnchorNode(id: string) {
  const wrapper = document.getElementById(id);
  // The inner paint node inherits rotation; several outer box wrappers only
  // carry the unrotated element coordinates.
  return (
    wrapper?.querySelector<HTMLElement>('.element-content') ??
    wrapper?.querySelector<HTMLElement>('[class^="base-element-"]')
  );
}

/**
 * Tracks a renderer paint node because its viewport rect reflects renderer
 * scale and transforms without consulting an application store.
 */
export function useToolbarAnchor(
  elementId: string,
  elementIdPrefix = 'slide-element-',
): TrackedToolbarRect | null {
  const [anchor, setAnchor] = useState<TrackedToolbarRect | null>(null);
  const lastRectRef = useRef<TrackedToolbarRect | null>(null);

  const measure = useCallback(() => {
    if (!elementId || typeof document === 'undefined') {
      lastRectRef.current = null;
      setAnchor((previous) => (previous === null ? previous : null));
      return false;
    }

    const node = getAnchorNode(elementIdPrefix + elementId);
    if (!node || !node.isConnected) {
      const changed = lastRectRef.current !== null;
      lastRectRef.current = null;
      setAnchor((previous) => (previous === null ? previous : null));
      return changed;
    }

    const nextRect = measureEditorToolbarAnchor(node, elementId);
    const changed = !equalRects(lastRectRef.current, nextRect);
    lastRectRef.current = nextRect;
    setAnchor((previous) => (equalRects(previous, nextRect) ? previous : nextRect));
    return changed;
  }, [elementId, elementIdPrefix]);

  useLayoutEffect(() => {
    if (!elementId || typeof document === 'undefined') {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing a removed anchor is a layout lifecycle update.
      measure();
      return;
    }

    let frameId: number | null = null;
    let stableFrames = 0;
    let pointerDown = false;

    const scheduleFrame = () => {
      if (
        frameId !== null ||
        (!pointerDown && stableFrames >= 20) ||
        typeof window === 'undefined' ||
        typeof window.requestAnimationFrame === 'undefined'
      ) {
        return;
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        stableFrames = measure() ? 0 : stableFrames + 1;
        scheduleFrame();
      });
    };
    const update = () => {
      stableFrames = 0;
      measure();
      scheduleFrame();
    };

    update();

    const node = getAnchorNode(elementIdPrefix + elementId);
    const observer =
      node && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (observer && node) observer.observe(node);

    const onPointerDown = () => {
      pointerDown = true;
      update();
    };
    const onPointerUp = () => {
      pointerDown = false;
      update();
    };

    window.addEventListener('resize', update);
    window.addEventListener('keydown', update);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    document.addEventListener('scroll', update, true);

    return () => {
      if (frameId !== null && typeof window.cancelAnimationFrame !== 'undefined') {
        window.cancelAnimationFrame(frameId);
      }
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('keydown', update);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      document.removeEventListener('scroll', update, true);
    };
  }, [elementId, elementIdPrefix, measure]);

  return anchor;
}
