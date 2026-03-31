'use client';

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';
import type { PPTElement } from '@/lib/types/slides';
import { useI18n } from '@/lib/hooks/use-i18n';

export type WhiteboardCanvasHandle = {
  resetView: () => void;
};

type InteractiveWhiteboardCanvasProps = {
  canvasHeight: number;
  canvasWidth: number;
  containerWidth: number;
  containerHeight: number;
  containerScale: number;
  elements: PPTElement[];
  isClearing: boolean;
  onViewModifiedChange?: (modified: boolean) => void;
  readyHintText: string;
  readyText: string;
};

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
  const clearDelay = isClearing ? (totalElements - 1 - index) * 0.055 : 0;
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

const InteractiveWhiteboardCanvas = forwardRef<
  WhiteboardCanvasHandle,
  InteractiveWhiteboardCanvasProps
>(function InteractiveWhiteboardCanvas(
  {
    canvasHeight,
    canvasWidth,
    containerWidth,
    containerHeight,
    containerScale,
    elements,
    isClearing,
    onViewModifiedChange,
    readyHintText,
    readyText,
  },
  ref,
) {
  const [viewZoom, setViewZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const prevElementsLengthRef = useRef(elements.length);
  const resetTimerRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const isViewModified = viewZoom !== 1 || panX !== 0 || panY !== 0;

  // Zoom-aware pan boundary: ensure at least an edge of the canvas stays visible
  const clampPan = useCallback(
    (x: number, y: number, zoom: number) => {
      const totalScale = containerScale * zoom;
      const maxPanX = canvasWidth / 2 + containerWidth / (2 * totalScale);
      const maxPanY = canvasHeight / 2 + containerHeight / (2 * totalScale);
      return {
        x: Math.max(-maxPanX, Math.min(maxPanX, x)),
        y: Math.max(-maxPanY, Math.min(maxPanY, y)),
      };
    },
    [canvasWidth, canvasHeight, containerWidth, containerHeight, containerScale],
  );

  const resetView = useCallback((animate: boolean) => {
    setIsPanning(false);
    setIsResetting(animate);
    setViewZoom(1);
    setPanX(0);
    setPanY(0);

    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }

    if (!animate) {
      return;
    }

    resetTimerRef.current = window.setTimeout(() => {
      setIsResetting(false);
      resetTimerRef.current = null;
    }, 250);
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      resetView: () => resetView(true),
    }),
    [resetView],
  );

  // Notify parent when view modified state changes
  useEffect(() => {
    onViewModifiedChange?.(isViewModified);
  }, [isViewModified, onViewModifiedChange]);

  // Always-on drag/pan — no toggle needed
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) {
        return;
      }

      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, panX, panY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [panX, panY],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning) {
        return;
      }

      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      // Convert screen-space drag to canvas-space (accounts for both container scale and zoom)
      const effectiveScale = Math.max(containerScale * viewZoom, 0.001);

      const newPanX = panStartRef.current.panX + dx / effectiveScale;
      const newPanY = panStartRef.current.panY + dy / effectiveScale;
      const clamped = clampPan(newPanX, newPanY, viewZoom);
      setPanX(clamped.x);
      setPanY(clamped.y);
    },
    [containerScale, viewZoom, isPanning, clampPan],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }

    setIsPanning(false);
  }, []);

  // Zoom toward cursor
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) {
      return;
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (elements.length === 0) {
        return;
      }

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;

      setViewZoom((prevZoom) => {
        const newZoom = Math.min(5, Math.max(0.2, prevZoom * zoomFactor));

        // Adjust pan to keep the point under the cursor stationary
        const rect = el.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;

        const oldScale = containerScale * prevZoom;
        const newScale = containerScale * newZoom;
        const scaleDiff = 1 / newScale - 1 / oldScale;

        setPanX((prevPanX) => {
          const newPanX = prevPanX + (cursorX - containerWidth / 2) * scaleDiff;
          const maxPX = canvasWidth / 2 + containerWidth / (2 * newScale);
          return Math.max(-maxPX, Math.min(maxPX, newPanX));
        });

        setPanY((prevPanY) => {
          const newPanY = prevPanY + (cursorY - containerHeight / 2) * scaleDiff;
          const maxPY = canvasHeight / 2 + containerHeight / (2 * newScale);
          return Math.max(-maxPY, Math.min(maxPY, newPanY));
        });

        return newZoom;
      });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [elements.length, containerScale, containerWidth, containerHeight, canvasWidth, canvasHeight]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const prevLength = prevElementsLengthRef.current;
    const nextLength = elements.length;
    prevElementsLengthRef.current = nextLength;

    const clearedBoard = prevLength > 0 && nextLength === 0;
    const firstContentLoaded = prevLength === 0 && nextLength > 0;
    if (!clearedBoard && !firstContentLoaded) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        resetView(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [elements.length, resetView]);

  const handleDoubleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.preventDefault();
      resetView(true);
    },
    [resetView],
  );

  // Canvas position: centered in workspace, offset by pan, scaled by containerScale * viewZoom
  const totalScale = containerScale * viewZoom;
  const canvasScreenX = (containerWidth - canvasWidth * totalScale) / 2 + panX * totalScale;
  const canvasScreenY = (containerHeight - canvasHeight * totalScale) / 2 + panY * totalScale;
  const canvasTransform = `translate(${canvasScreenX}px, ${canvasScreenY}px) scale(${totalScale})`;

  return (
    /* Viewport — fills workspace, handles pointer events, no clipping */
    <div
      ref={viewportRef}
      className="w-full h-full relative select-none"
      style={{
        cursor: isPanning ? 'grabbing' : 'grab',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      {/* Bounded canvas — white background, positioned and scaled. No overflow-hidden so elements can spill into transparent space. */}
      <div
        className="absolute bg-white shadow-2xl rounded-lg border border-gray-200 dark:border-gray-600"
        style={{
          width: canvasWidth,
          height: canvasHeight,
          left: 0,
          top: 0,
          transform: canvasTransform,
          transformOrigin: '0 0',
          transition: isResetting ? 'transform 0.25s ease-out' : undefined,
        }}
      >
        {/* Empty state placeholder */}
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
                <p className="text-lg font-medium">{readyText}</p>
                <p className="text-sm mt-1">{readyHintText}</p>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Content layer — elements rendered at their raw coordinates */}
        <div className="absolute inset-0">
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
      </div>
    </div>
  );
});

/**
 * Whiteboard canvas with pan, zoom, auto-fit, and bounded viewport.
 */
export type WhiteboardCanvasProps = {
  onViewModifiedChange?: (modified: boolean) => void;
};

export const WhiteboardCanvas = forwardRef<WhiteboardCanvasHandle, WhiteboardCanvasProps>(
  function WhiteboardCanvas({ onViewModifiedChange }, ref) {
    const { t } = useI18n();
    const stage = useStageStore.use.stage();
    const isClearing = useCanvasStore.use.whiteboardClearing();
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

    const whiteboard = stage?.whiteboard?.[0];
    const rawElements = whiteboard?.elements;
    const elements = useMemo(() => rawElements ?? [], [rawElements]);

    const canvasWidth = 1000;
    const canvasHeight = 562.5;

    const containerScale = useMemo(() => {
      if (containerSize.width === 0 || containerSize.height === 0) return 1;
      return Math.min(containerSize.width / canvasWidth, containerSize.height / canvasHeight);
    }, [containerSize.width, containerSize.height, canvasWidth, canvasHeight]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          setContainerSize({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          });
        }
      });
      observer.observe(container);

      // Initial measurement
      setContainerSize({ width: container.clientWidth, height: container.clientHeight });

      return () => observer.disconnect();
    }, []);

    return (
      <div ref={containerRef} className="w-full h-full overflow-hidden">
        <InteractiveWhiteboardCanvas
          ref={ref}
          canvasHeight={canvasHeight}
          canvasWidth={canvasWidth}
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
          containerScale={containerScale}
          elements={elements}
          isClearing={isClearing}
          onViewModifiedChange={onViewModifiedChange}
          readyHintText={t('whiteboard.readyHint')}
          readyText={t('whiteboard.ready')}
        />
      </div>
    );
  },
);
