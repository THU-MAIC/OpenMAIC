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

function toTrackedRect(rect: DOMRect): TrackedToolbarRect {
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
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

    const wrapper = document.getElementById(`${elementIdPrefix}${elementId}`);
    const node =
      wrapper?.querySelector<HTMLElement>(
        '.base-element-text, .base-element-image, .base-element-shape, .base-element-table, .base-element-chart, .base-element-line, .base-element-latex, .base-element-video, .base-element-audio',
      ) ?? null;
    if (!node || !node.isConnected) {
      const changed = lastRectRef.current !== null;
      lastRectRef.current = null;
      setAnchor((previous) => (previous === null ? previous : null));
      return changed;
    }

    const nextRect = toTrackedRect(node.getBoundingClientRect());
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

    const scheduleFrame = () => {
      if (
        frameId !== null ||
        stableFrames >= 20 ||
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

    const wrapper = document.getElementById(`${elementIdPrefix}${elementId}`);
    const node =
      wrapper?.querySelector<HTMLElement>(
        '.base-element-text, .base-element-image, .base-element-shape, .base-element-table, .base-element-chart, .base-element-line, .base-element-latex, .base-element-video, .base-element-audio',
      ) ?? null;
    const observer =
      node && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null;
    if (observer && node) observer.observe(node);

    window.addEventListener('resize', update);
    window.addEventListener('pointerdown', update);
    window.addEventListener('pointerup', update);
    window.addEventListener('pointercancel', update);
    document.addEventListener('scroll', update, true);

    return () => {
      if (frameId !== null && typeof window.cancelAnimationFrame !== 'undefined') {
        window.cancelAnimationFrame(frameId);
      }
      observer?.disconnect();
      window.removeEventListener('resize', update);
      window.removeEventListener('pointerdown', update);
      window.removeEventListener('pointerup', update);
      window.removeEventListener('pointercancel', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [elementId, elementIdPrefix, measure]);

  return anchor;
}
