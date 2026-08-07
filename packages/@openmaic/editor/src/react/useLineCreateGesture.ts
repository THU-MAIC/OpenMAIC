'use client';

import {
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from 'react';
import type { ViewportStyles } from '@openmaic/renderer';
import type { LineCreateGeometry } from './types';

/** Mirrors the old editor's 30px draw-to-insert threshold. */
const LINE_CREATE_MIN_SCREEN_PX = 30;

export interface UseLineCreateGestureArgs {
  readonly active: boolean;
  readonly scale: number;
  readonly overlayRef: RefObject<HTMLElement | null>;
  readonly viewportStyles: ViewportStyles;
  readonly onCreate?: (geometry: LineCreateGeometry) => void;
  readonly onCancel?: () => void;
}

export interface UseLineCreateGestureResult {
  readonly preview: LineCreateGeometry | null;
  readonly onCanvasPointerDown: (event: ReactPointerEvent) => void;
  readonly onCanvasContextMenu: (event: ReactMouseEvent) => void;
}

/** Store-free draw-to-insert line gesture with live endpoint preview. */
export function useLineCreateGesture({
  active,
  scale,
  overlayRef,
  viewportStyles,
  onCreate,
  onCancel,
}: UseLineCreateGestureArgs): UseLineCreateGestureResult {
  const [preview, setPreview] = useState<LineCreateGeometry | null>(null);
  const teardownRef = useRef<(() => void) | null>(null);
  const activePointerRef = useRef<number | null>(null);

  const clearGesture = () => {
    teardownRef.current?.();
    teardownRef.current = null;
    activePointerRef.current = null;
    setPreview(null);
  };

  useEffect(() => () => clearGesture(), []);
  useEffect(() => {
    if (active) return;
    const timer = window.setTimeout(clearGesture);
    return () => window.clearTimeout(timer);
  }, [active]);

  const onCanvasPointerDown = (event: ReactPointerEvent) => {
    if (!active || !onCreate || event.button !== 0 || activePointerRef.current !== null) return;
    const overlay = overlayRef.current;
    if (!overlay) return;

    event.preventDefault();
    event.stopPropagation();
    activePointerRef.current = event.pointerId;
    const overlayRect = overlay.getBoundingClientRect();
    const effectiveScale = scale || 1;
    const toCanvas = (clientX: number, clientY: number): [number, number] => [
      (clientX - overlayRect.left - viewportStyles.left) / effectiveScale,
      (clientY - overlayRect.top - viewportStyles.top) / effectiveScale,
    ];
    const start = toCanvas(event.clientX, event.clientY);
    const startClientX = event.clientX;
    const startClientY = event.clientY;

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
      setPreview(null);
    };
    const handleMove = (next: PointerEvent) => {
      if (next.pointerId !== activePointerRef.current) return;
      setPreview({ start, end: toCanvas(next.clientX, next.clientY) });
    };
    const handleUp = (next: PointerEvent) => {
      if (next.pointerId !== activePointerRef.current) return;
      const exceedsThreshold =
        Math.max(Math.abs(next.clientX - startClientX), Math.abs(next.clientY - startClientY)) >=
        LINE_CREATE_MIN_SCREEN_PX;
      const end = toCanvas(next.clientX, next.clientY);
      finish();
      if (exceedsThreshold) onCreate({ start, end });
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

  const onCanvasContextMenu = (event: ReactMouseEvent) => {
    if (!active) return;
    event.preventDefault();
    clearGesture();
    onCancel?.();
  };

  return { preview, onCanvasPointerDown, onCanvasContextMenu };
}
