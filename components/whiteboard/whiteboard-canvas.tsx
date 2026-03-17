'use client';

import { useRef, useState, useEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';
import type { PPTElement } from '@/lib/types/slides';
import { useI18n } from '@/lib/hooks/use-i18n';

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
 * Whiteboard canvas
 */
export function WhiteboardCanvas() {
  const { t } = useI18n();
  const stage = useStageStore.use.stage();
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  // Get whiteboard elements
  const whiteboard = stage?.whiteboard?.[0];
  const elements = whiteboard?.elements || [];

  // Whiteboard fixed size: 1000 x 562.5 (16:9)
  const canvasWidth = 1000;
  const canvasHeight = 562.5;

  // Responsive scaling: scale canvas proportionally to fill container
  const updateScale = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const { clientWidth, clientHeight } = container;
    const scaleX = clientWidth / canvasWidth;
    const scaleY = clientHeight / canvasHeight;
    setScale(Math.min(scaleX, scaleY));
  }, [canvasWidth, canvasHeight]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(updateScale);
    observer.observe(container);
    updateScale();
    return () => observer.disconnect();
  }, [updateScale]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full flex items-center justify-center overflow-hidden"
    >
      {/* Layout wrapper: its size matches the scaled visual size so flex centering works correctly */}
      <div style={{ width: canvasWidth * scale, height: canvasHeight * scale }}>
        <div
          className="relative bg-white shadow-2xl rounded-lg overflow-hidden"
          style={{
            width: canvasWidth,
            height: canvasHeight,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }}
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
      </div>
    </div>
  );
}
