'use client';

import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import type { SpotlightEffectOptions } from '../types/effects';

interface SpotlightRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SpotlightOverlayProps {
  options?: SpotlightEffectOptions;
  /** ID prefix the SlideElement uses on its root div. Default `slide-element-`. */
  elementIdPrefix?: string;
  /** Remeasure when host element data changes without changing the target ID. */
  measurementKey?: unknown;
}

export function SpotlightOverlay({
  options,
  elementIdPrefix = 'slide-element-',
  measurementKey,
}: SpotlightOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<SpotlightRect | null>(null);

  const spotlightElementId = options?.elementId;

  const measure = useCallback(() => {
    if (!spotlightElementId || !containerRef.current) {
      setRect(null);
      return;
    }

    const domElement = document.getElementById(`${elementIdPrefix}${spotlightElementId}`);
    if (!domElement) {
      setRect(null);
      return;
    }

    const contentEl = domElement.querySelector('.element-content');
    const targetEl = contentEl ?? domElement;

    const containerRect = containerRef.current.getBoundingClientRect();
    const targetRect = targetEl.getBoundingClientRect();

    if (containerRect.width === 0 || containerRect.height === 0) {
      setRect(null);
      return;
    }

    setRect({
      x: ((targetRect.left - containerRect.left) / containerRect.width) * 100,
      y: ((targetRect.top - containerRect.top) / containerRect.height) * 100,
      w: (targetRect.width / containerRect.width) * 100,
      h: (targetRect.height / containerRect.height) * 100,
    });
  }, [spotlightElementId, elementIdPrefix]);

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement requires effect
    measure();

    const container = containerRef.current;
    if (!container || !spotlightElementId) return;

    const root = document.getElementById(`${elementIdPrefix}${spotlightElementId}`);
    const target = root?.querySelector('.element-content') ?? root;
    if (!target) return;

    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(target);

    const media = target.querySelectorAll('img, video');
    media.forEach((element) => {
      element.addEventListener('load', measure);
      element.addEventListener('loadedmetadata', measure);
    });

    return () => {
      observer.disconnect();
      media.forEach((element) => {
        element.removeEventListener('load', measure);
        element.removeEventListener('loadedmetadata', measure);
      });
    };
  }, [measure, measurementKey, spotlightElementId, elementIdPrefix]);

  const active = !!spotlightElementId && !!rect;
  const dimness = options?.dimness ?? 0.7;

  return (
    <div
      ref={containerRef}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 100,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      <AnimatePresence mode="wait">
        {active && rect && (
          <motion.div
            key={`spotlight-${spotlightElementId}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            style={{ position: 'absolute', inset: 0 }}
          >
            <svg
              width="100%"
              height="100%"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              style={{ position: 'absolute', inset: 0 }}
            >
              <defs>
                <mask id={`mask-${spotlightElementId}`}>
                  <rect x="0" y="0" width="100" height="100" fill="white" />
                  <motion.rect
                    fill="black"
                    initial={{
                      x: rect.x - 8,
                      y: rect.y - 8,
                      width: rect.w + 16,
                      height: rect.h + 16,
                      rx: 4,
                    }}
                    animate={{
                      x: rect.x - 0.4,
                      y: rect.y - 0.6,
                      width: rect.w + 0.8,
                      height: rect.h + 1.2,
                      rx: 1,
                    }}
                    transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  />
                </mask>
              </defs>

              <rect
                width="100"
                height="100"
                fill={`rgba(0,0,0,${dimness})`}
                mask={`url(#mask-${spotlightElementId})`}
              />

              <motion.rect
                initial={{
                  x: rect.x - 4,
                  y: rect.y - 4,
                  width: rect.w + 8,
                  height: rect.h + 8,
                  opacity: 0,
                  rx: 2,
                }}
                animate={{
                  x: rect.x - 0.4,
                  y: rect.y - 0.6,
                  width: rect.w + 0.8,
                  height: rect.h + 1.2,
                  opacity: 1,
                  rx: 1,
                }}
                fill="none"
                stroke="rgba(255,255,255,0.7)"
                strokeWidth="1.2"
                style={{ vectorEffect: 'non-scaling-stroke' } as React.CSSProperties}
                transition={{ duration: 0.5, delay: 0.05, ease: [0.16, 1, 0.3, 1] }}
              />
            </svg>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
