'use client';

import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';
import type { PPTElement, PPTLineElement } from '@/lib/types/slides';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getElementRange } from '@/lib/utils/element';

type ElementBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

function getLineBounds(element: PPTLineElement): ElementBounds {
  const originX = element.left ?? 0;
  const originY = element.top ?? 0;
  const points: Array<[number, number]> = [element.start, element.end];

  if (element.broken) {
    points.push(element.broken);
  }

  if (element.broken2) {
    const horizontalFirst =
      Math.abs(element.end[0] - element.start[0]) >= Math.abs(element.end[1] - element.start[1]);
    if (horizontalFirst) {
      points.push([element.broken2[0], element.start[1]], [element.broken2[0], element.end[1]]);
    } else {
      points.push([element.start[0], element.broken2[1]], [element.end[0], element.broken2[1]]);
    }
  }

  if (element.curve) {
    points.push(element.curve);
  }

  if (element.cubic) {
    points.push(...element.cubic);
  }

  const xs = points.map(([x]) => originX + x);
  const ys = points.map(([, y]) => originY + y);
  const strokePad = Math.max(element.width ?? 0, 1) / 2;
  const markerPad = element.points.some(Boolean) ? Math.max(element.width ?? 0, 1) * 1.5 : 0;
  const pad = strokePad + markerPad;

  return {
    minX: Math.min(...xs) - pad,
    minY: Math.min(...ys) - pad,
    maxX: Math.max(...xs) + pad,
    maxY: Math.max(...ys) + pad,
  };
}

function getWhiteboardElementBounds(element: PPTElement): ElementBounds {
  if (element.type === 'line') {
    return getLineBounds(element);
  }

  return getElementRange(element);
}

/**
 * Animated element wrapper
 */
function AnimatedElement({
  element,
  index,
  isClearing,
  totalElements,
}: {
  element: PPTElement;
  index: number;
  isClearing: boolean;
  totalElements: number;
}) {
  // Reverse stagger: last-drawn element exits first for a "wipe" cascade
  const clearDelay = isClearing ? (totalElements - 1 - index) * 0.055 : 0;
  // Alternate tilt direction for organic feel
  const clearRotate = isClearing ? (index % 2 === 0 ? 1 : -1) * (2 + index * 0.4) : 0;

  return (
    <motion.div
      layout={false}
      initial={{ opacity: 0, scale: 0.92, y: 8, filter: 'blur(4px)' }}
      animate={
        isClearing
          ? {
              opacity: 0,
              scale: 0.35,
              y: -35,
              rotate: clearRotate,
              filter: 'blur(8px)',
              transition: {
                duration: 0.38,
                delay: clearDelay,
                ease: [0.5, 0, 1, 0.6],
              },
            }
          : {
              opacity: 1,
              scale: 1,
              y: 0,
              rotate: 0,
              filter: 'blur(0px)',
              transition: {
                duration: 0.45,
                ease: [0.16, 1, 0.3, 1],
                delay: index * 0.05,
              },
            }
      }
      exit={{
        opacity: 0,
        scale: 0.85,
        transition: { duration: 0.2 },
      }}
      className="absolute inset-0"
      style={{ pointerEvents: isClearing ? 'none' : undefined }}
    >
      <div style={{ pointerEvents: 'auto' }}>
        <ScreenElement elementInfo={element} elementIndex={index} animate />
      </div>
    </motion.div>
  );
}

/**
 * Whiteboard canvas with pan & zoom support.
 *
 * Features:
 * - Responsive scaling to fill the container
 * - Auto-fit: when elements overflow the canvas, content is scaled & centered
 *   so nothing is clipped
 * - Drag-to-pan: hold mouse and drag to pan around the whiteboard
 * - Scroll-to-zoom: use the scroll wheel to zoom in/out (anchored to top-left)
 * - Double-click to reset view to auto-fit
 */
export function WhiteboardCanvas() {
  const { t } = useI18n();
  const stage = useStageStore.use.stage();
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerScale, setContainerScale] = useState(1);

  // Get whiteboard elements
  const whiteboard = stage?.whiteboard?.[0];
  const elements = useMemo(() => whiteboard?.elements || [], [whiteboard?.elements]);
  const elementsLenRef = useRef(elements.length);
  elementsLenRef.current = elements.length;

  // Whiteboard fixed size: 1000 x 562.5 (16:9)
  const canvasWidth = 1000;
  const canvasHeight = 562.5;

  // ==================== Responsive container scaling ====================
  const updateContainerScale = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const { clientWidth, clientHeight } = container;
    const scaleX = clientWidth / canvasWidth;
    const scaleY = clientHeight / canvasHeight;
    setContainerScale(Math.min(scaleX, scaleY));
  }, [canvasWidth, canvasHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(updateContainerScale);
    observer.observe(container);
    updateContainerScale();
    return () => observer.disconnect();
  }, [updateContainerScale]);

  // ==================== Auto-fit: compute initial transform ====================
  const PADDING = 24; // px padding inside the canvas edges

  const autoFitTransform = useMemo(() => {
    if (elements.length === 0) return { scale: 1, tx: 0, ty: 0 };

    // Compute bounding box of all elements
    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const el of elements) {
      const bounds = getWhiteboardElementBounds(el);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    // Only apply fit when content actually overflows the canvas
    const overflowsX = minX < 0 || maxX > canvasWidth;
    const overflowsY = minY < 0 || maxY > canvasHeight;
    if (!overflowsX && !overflowsY) return { scale: 1, tx: 0, ty: 0 };

    // Scale down to fit all content within the canvas (with padding)
    const availW = canvasWidth - PADDING * 2;
    const availH = canvasHeight - PADDING * 2;
    const fitScale = Math.min(1, availW / contentWidth, availH / contentHeight);

    // Center the content
    const scaledW = contentWidth * fitScale;
    const scaledH = contentHeight * fitScale;
    const tx = (canvasWidth - scaledW) / 2 - minX * fitScale;
    const ty = (canvasHeight - scaledH) / 2 - minY * fitScale;

    return { scale: fitScale, tx, ty };
  }, [elements, canvasWidth, canvasHeight]);

  // ==================== Pan & Zoom state ====================
  const [viewZoom, setViewZoom] = useState(1); // user zoom (relative to auto-fit)
  const [panX, setPanX] = useState(0); // user pan offset in canvas-space px
  const [panY, setPanY] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const [isResetting, setIsResetting] = useState(false);
  const resetTimerRef = useRef<number | null>(null);
  const isViewModified = viewZoom !== 1 || panX !== 0 || panY !== 0;
  const hasOverflow = autoFitTransform.scale < 1;
  const canPan = elements.length > 0 && (hasOverflow || isViewModified);

  // Reset view only when whiteboard content actually changes (not on every re-render).
  // Use a stable string key from element IDs instead of object reference.
  const elementsKey = useMemo(() => elements.map((e) => e.id).join(','), [elements]);
  useEffect(() => {
    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setIsPanning(false);
    setIsResetting(false);
    setViewZoom(1);
    setPanX(0);
    setPanY(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [elementsKey]);

  // ---- Drag-to-pan handlers ----
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Only pan with left mouse button or single touch
      if (e.button !== 0) return;
      if (!canPan) return;
      e.preventDefault(); // prevent text selection
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, panX, panY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [canPan, panX, panY],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning) return;
      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      // Divide by containerScale so pan distance is consistent regardless of container size
      // Guard against zero to prevent NaN when container is hidden or has zero dimensions
      const effectiveScale = Math.max(containerScale, 0.001);
      setPanX(panStartRef.current.panX + dx / effectiveScale);
      setPanY(panStartRef.current.panY + dy / effectiveScale);
    },
    [containerScale, isPanning],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }
    setIsPanning(false);
  }, []);

  // ---- Scroll-to-zoom: must use native listener for { passive: false } ----
  const canvasRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      // Don't zoom when whiteboard is empty
      if (elementsLenRef.current === 0) return;
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      setViewZoom((prev) => Math.min(5, Math.max(0.2, prev * zoomFactor)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  // ---- Double-click to reset (with smooth animation) ----
  const handleDoubleClick = useCallback((e?: React.MouseEvent) => {
    e?.preventDefault(); // prevent text selection
    setIsPanning(false);
    setIsResetting(true);
    setViewZoom(1);
    setPanX(0);
    setPanY(0);
    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => {
      setIsResetting(false);
      resetTimerRef.current = null;
    }, 250);
  }, []);

  // ==================== Computed content transform ====================
  // Combines auto-fit + user pan/zoom into a single CSS transform
  const contentTransform = useMemo(() => {
    const s = autoFitTransform.scale * viewZoom;
    const tx = autoFitTransform.tx + panX;
    const ty = autoFitTransform.ty + panY;
    return `translate(${tx}px, ${ty}px) scale(${s})`;
  }, [autoFitTransform, viewZoom, panX, panY]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center overflow-hidden"
    >
      {/* Layout wrapper: its size matches the scaled visual size so flex centering works correctly */}
      <div style={{ width: canvasWidth * containerScale, height: canvasHeight * containerScale }}>
        <div
          ref={canvasRef}
          className="relative bg-white shadow-2xl rounded-lg overflow-hidden select-none"
          style={{
            width: canvasWidth,
            height: canvasHeight,
            transform: `scale(${containerScale})`,
            transformOrigin: 'top left',
            cursor: isPanning ? 'grabbing' : canPan ? 'grab' : undefined,
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          onDoubleClick={handleDoubleClick}
        >
          {/* Placeholder when empty and not mid-clear */}
          <AnimatePresence>
            {elements.length === 0 && !isClearing && (
              <motion.div
                key="placeholder"
                initial={{ opacity: 0 }}
                animate={{
                  opacity: 1,
                  transition: { delay: 0.25, duration: 0.4 },
                }}
                exit={{ opacity: 0, transition: { duration: 0.15 } }}
                className="absolute inset-0 flex items-center justify-center"
              >
                <div className="text-center text-gray-400">
                  <p className="text-lg font-medium">{t('whiteboard.ready')}</p>
                  <p className="text-sm mt-1">{t('whiteboard.readyHint')}</p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* Content layer — auto-fit + user pan/zoom applied */}
          <div
            className="absolute inset-0"
            style={{
              transform: contentTransform,
              transformOrigin: '0 0',
              transition: isResetting ? 'transform 0.25s ease-out' : undefined,
            }}
          >
            {/* Elements — always rendered so AnimatePresence can track exits */}
            <AnimatePresence mode="popLayout">
              {elements.map((element, index) => (
                <AnimatedElement
                  key={element.id}
                  element={element}
                  index={index}
                  isClearing={isClearing}
                  totalElements={elements.length}
                />
              ))}
            </AnimatePresence>
          </div>

          {/* Reset hint — shown when view is modified */}
          <AnimatePresence>
            {isViewModified && elements.length > 0 && (
              <motion.button
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 0.7 }}
                exit={{ opacity: 0 }}
                whileHover={{ opacity: 1 }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  handleDoubleClick();
                }}
                className="absolute bottom-3 right-3 z-50 px-2.5 py-1 rounded-md
                  bg-black/60 text-white text-xs backdrop-blur-sm
                  hover:bg-black/80 transition-colors cursor-pointer select-none"
              >
                {t('whiteboard.resetView')}
              </motion.button>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
