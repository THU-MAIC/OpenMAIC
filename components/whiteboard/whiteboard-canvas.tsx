'use client';

import { useRef, useState, useEffect, useCallback, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';
import { elementFingerprint } from '@/lib/utils/element-fingerprint';
import type { PPTElement, PPTLineElement } from '@/lib/types/slides';
import { useI18n } from '@/lib/hooks/use-i18n';
import { getElementRange } from '@/lib/utils/element';

type ElementBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type InteractiveWhiteboardCanvasProps = {
  autoFitTransform: {
    scale: number;
    tx: number;
    ty: number;
  };
  canvasHeight: number;
  canvasWidth: number;
  containerScale: number;
  elements: PPTElement[];
  isClearing: boolean;
  readyHintText: string;
  readyText: string;
  resetViewText: string;
  zoomHintText: string;
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

function InteractiveWhiteboardCanvas({
  autoFitTransform,
  canvasHeight,
  canvasWidth,
  containerScale,
  elements,
  isClearing,
  readyHintText,
  readyText,
  resetViewText,
  zoomHintText,
}: InteractiveWhiteboardCanvasProps) {
  const [viewZoom, setViewZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const [hintTimedOut, setHintTimedOut] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const prevElementsLengthRef = useRef(elements.length);
  const resetTimerRef = useRef<number | null>(null);
  const hintTimerRef = useRef<number | null>(null);
  const hintEpochRef = useRef(0);
  const canvasRef = useRef<HTMLDivElement>(null);

  const isViewModified = viewZoom !== 1 || panX !== 0 || panY !== 0;
  const hasOverflow = autoFitTransform.scale < 1;
  const canPan = elements.length > 0 && (hasOverflow || isViewModified);
  const hintEpoch = elements.length > 0 && !isViewModified ? 1 : 0;
  const showHint = hintEpoch === 1 && !hintTimedOut;

  useEffect(() => {
    if (hintEpoch === 0) {
      return;
    }

    const epoch = ++hintEpochRef.current;
    hintTimerRef.current = window.setTimeout(() => {
      if (hintEpochRef.current === epoch) {
        setHintTimedOut(true);
      }
    }, 3000);

    return () => {
      if (hintTimerRef.current !== null) {
        window.clearTimeout(hintTimerRef.current);
        hintTimerRef.current = null;
      }
    };
  }, [hintEpoch]);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || !canPan) {
        return;
      }

      e.preventDefault();
      setIsPanning(true);
      setHintTimedOut(false);
      panStartRef.current = { x: e.clientX, y: e.clientY, panX, panY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [canPan, panX, panY],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning) {
        return;
      }

      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
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

  const resetView = useCallback((animate: boolean) => {
    setIsPanning(false);
    setIsResetting(animate);
    setHintTimedOut(false);
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

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) {
      return;
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (elements.length === 0) {
        return;
      }

      setHintTimedOut(false);
      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;
      setViewZoom((prev) => Math.min(5, Math.max(0.2, prev * zoomFactor)));
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [elements.length]);

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

  const contentTransform = useMemo(() => {
    const scale = autoFitTransform.scale * viewZoom;
    const tx = autoFitTransform.tx + panX;
    const ty = autoFitTransform.ty + panY;
    return `translate(${tx}px, ${ty}px) scale(${scale})`;
  }, [autoFitTransform, panX, panY, viewZoom]);

  return (
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

      <div
        className="absolute inset-0"
        style={{
          transform: contentTransform,
          transformOrigin: '0 0',
          transition: isResetting ? 'transform 0.25s ease-out' : undefined,
        }}
      >
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

      <AnimatePresence>
        {showHint && !isViewModified && elements.length > 0 && (
          <motion.div
            key="zoom-hint"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5, transition: { delay: 0.6, duration: 0.4 } }}
            exit={{ opacity: 0, transition: { duration: 0.3 } }}
            className="absolute bottom-3 left-3 z-50 px-2.5 py-1 rounded-md
              bg-black/40 text-white text-xs backdrop-blur-sm select-none pointer-events-none"
          >
            {zoomHintText}
          </motion.div>
        )}
      </AnimatePresence>

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
            {resetViewText}
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Whiteboard canvas with pan, zoom, auto-fit, and history auto-snapshot support.
 */
export function WhiteboardCanvas() {
  const { t } = useI18n();
  const stage = useStageStore.use.stage();
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerScale, setContainerScale] = useState(1);

  const whiteboard = stage?.whiteboard?.[0];
  const rawElements = whiteboard?.elements;
  const elements = useMemo(() => rawElements ?? [], [rawElements]);
  const elementsKey = useMemo(() => elementFingerprint(elements), [elements]);
  const elementsRef = useRef(elements);
  const snapshotTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    elementsRef.current = elements;
  }, [elements]);

  useEffect(() => {
    if (snapshotTimerRef.current) {
      clearTimeout(snapshotTimerRef.current);
      snapshotTimerRef.current = null;
    }

    if (elements.length === 0 || isClearing) {
      return;
    }

    const historyStore = useWhiteboardHistoryStore.getState();
    if (historyStore.restoredKey && historyStore.restoredKey === elementsKey) {
      historyStore.setRestoredKey(null);
      return;
    }

    snapshotTimerRef.current = setTimeout(() => {
      const current = elementsRef.current;
      if (current.length > 0) {
        useWhiteboardHistoryStore.getState().pushSnapshot(current);
      }
    }, 2000);

    return () => {
      if (snapshotTimerRef.current) {
        clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
    };
  }, [elements.length, elementsKey, isClearing]);

  useEffect(() => {
    return () => {
      if (snapshotTimerRef.current) {
        clearTimeout(snapshotTimerRef.current);
      }
    };
  }, []);

  const canvasWidth = 1000;
  const canvasHeight = 562.5;
  const padding = 24;

  const updateContainerScale = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const { clientWidth, clientHeight } = container;
    const scaleX = clientWidth / canvasWidth;
    const scaleY = clientHeight / canvasHeight;
    setContainerScale(Math.min(scaleX, scaleY));
  }, [canvasWidth, canvasHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    const observer = new ResizeObserver(updateContainerScale);
    observer.observe(container);
    updateContainerScale();

    return () => observer.disconnect();
  }, [updateContainerScale]);

  const autoFitTransform = useMemo(() => {
    if (elements.length === 0) {
      return { scale: 1, tx: 0, ty: 0 };
    }

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const element of elements) {
      const bounds = getWhiteboardElementBounds(element);
      minX = Math.min(minX, bounds.minX);
      minY = Math.min(minY, bounds.minY);
      maxX = Math.max(maxX, bounds.maxX);
      maxY = Math.max(maxY, bounds.maxY);
    }

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;
    const overflowsX = minX < 0 || maxX > canvasWidth;
    const overflowsY = minY < 0 || maxY > canvasHeight;

    if (!overflowsX && !overflowsY) {
      return { scale: 1, tx: 0, ty: 0 };
    }

    const availableWidth = canvasWidth - padding * 2;
    const availableHeight = canvasHeight - padding * 2;
    const fitScale = Math.min(1, availableWidth / contentWidth, availableHeight / contentHeight);
    const scaledWidth = contentWidth * fitScale;
    const scaledHeight = contentHeight * fitScale;

    return {
      scale: fitScale,
      tx: (canvasWidth - scaledWidth) / 2 - minX * fitScale,
      ty: (canvasHeight - scaledHeight) / 2 - minY * fitScale,
    };
  }, [canvasHeight, canvasWidth, elements, padding]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center overflow-hidden"
    >
      <div style={{ width: canvasWidth * containerScale, height: canvasHeight * containerScale }}>
        <InteractiveWhiteboardCanvas
          autoFitTransform={autoFitTransform}
          canvasHeight={canvasHeight}
          canvasWidth={canvasWidth}
          containerScale={containerScale}
          elements={elements}
          isClearing={isClearing}
          readyHintText={t('whiteboard.readyHint')}
          readyText={t('whiteboard.ready')}
          resetViewText={t('whiteboard.resetView')}
          zoomHintText={t('whiteboard.zoomHint')}
        />
      </div>
    </div>
  );
}
