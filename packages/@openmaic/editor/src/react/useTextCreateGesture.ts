'use client';

import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { ViewportStyles } from '@openmaic/renderer';
import type { TextCreateRect } from './types';

const TEXT_CLICK_MIN = 24;
const TEXT_DEFAULT_WIDTH = 300;
const TEXT_DEFAULT_HEIGHT = 60;

interface CanvasPoint {
  readonly x: number;
  readonly y: number;
}

function rectFromPoints(start: CanvasPoint, end: CanvasPoint): TextCreateRect {
  return {
    left: Math.min(start.x, end.x),
    top: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

export interface UseTextCreateGestureArgs {
  readonly active: boolean;
  readonly scale: number;
  readonly overlayRef: RefObject<HTMLElement | null>;
  readonly viewportStyles: ViewportStyles;
  readonly onCreate?: (rect: TextCreateRect) => void;
}

export interface UseTextCreateGestureResult {
  readonly previewRect: TextCreateRect | null;
  readonly onCanvasPointerDown: (event: ReactPointerEvent) => void;
}

/**
 * Renderer-owned pointer geometry for legacy-compatible text insertion. The
 * host intentionally owns the resulting DSL element and persistence boundary.
 */
export function useTextCreateGesture({
  active,
  scale,
  overlayRef,
  viewportStyles,
  onCreate,
}: UseTextCreateGestureArgs): UseTextCreateGestureResult {
  const [previewRect, setPreviewRect] = useState<TextCreateRect | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const activePointerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      teardownRef.current?.();
      teardownRef.current = null;
      activePointerRef.current = null;
    },
    [],
  );

  const onCanvasPointerDown = (event: ReactPointerEvent) => {
    if (!active || !onCreate || event.button !== 0 || activePointerRef.current !== null) return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    event.preventDefault();
    event.stopPropagation();
    activePointerRef.current = event.pointerId;
    const overlayRect = overlay.getBoundingClientRect();
    const effectiveScale = scale || 1;
    const toCanvas = (clientX: number, clientY: number): CanvasPoint => ({
      x: (clientX - overlayRect.left - viewportStyles.left) / effectiveScale,
      y: (clientY - overlayRect.top - viewportStyles.top) / effectiveScale,
    });
    const start = toCanvas(event.clientX, event.clientY);

    try {
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is optional in jsdom and older browsers.
    }

    const removeListeners = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };
    const finish = () => {
      removeListeners();
      teardownRef.current = null;
      activePointerRef.current = null;
      setPreviewRect(null);
    };
    const handleMove = (next: PointerEvent) => {
      if (next.pointerId !== activePointerRef.current) return;
      setPreviewRect(rectFromPoints(start, toCanvas(next.clientX, next.clientY)));
    };
    const handleUp = (next: PointerEvent) => {
      if (next.pointerId !== activePointerRef.current) return;
      const rect = rectFromPoints(start, toCanvas(next.clientX, next.clientY));
      finish();
      onCreate({
        left: rect.left,
        top: rect.top,
        width: rect.width < TEXT_CLICK_MIN ? TEXT_DEFAULT_WIDTH : rect.width,
        height: rect.height < TEXT_CLICK_MIN ? TEXT_DEFAULT_HEIGHT : rect.height,
      });
    };
    const handleCancel = (next: PointerEvent) => {
      if (next.pointerId !== activePointerRef.current) return;
      finish();
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    teardownRef.current = removeListeners;
  };

  return { previewRect, onCanvasPointerDown };
}
