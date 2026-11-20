'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { visibleClientRect } from '@/lib/edit/visible-client-rect';
import { observeFullscreenPortalTarget } from '@/lib/hooks/use-fullscreen-portal-target';

function InteractiveCourseEndPortal({ children }: { readonly children: ReactNode }) {
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);

  const attachAnchor = useCallback((anchor: HTMLDivElement | null) => {
    if (!anchor) return;

    // React keeps CourseEnd mounted while its portal container stays the same.
    const layer = document.createElement('div');
    layer.className = 'fixed z-[2] overflow-hidden';
    const unsubscribe = observeFullscreenPortalTarget((target) => {
      if (layer.parentElement === target) return;
      if (layer.isConnected && 'moveBefore' in target && typeof target.moveBefore === 'function') {
        target.moveBefore(layer, null);
      } else {
        const focused = document.activeElement;
        target.appendChild(layer);
        if (focused instanceof HTMLElement && layer.contains(focused)) {
          focused.focus({ preventScroll: true });
        }
      }
    });
    setPortal(layer);

    let frame = 0;
    let lastBounds = '';
    const position = () => {
      const { left, top, width, height } = visibleClientRect(anchor);
      const bounds = `${left}px ${top}px ${width}px ${height}px`;
      if (bounds !== lastBounds) {
        Object.assign(layer.style, {
          left: `${left}px`,
          top: `${top}px`,
          width: `${width}px`,
          height: `${height}px`,
        });
        lastBounds = bounds;
      }
      frame = requestAnimationFrame(position);
    };
    position();
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
      layer.remove();
    };
  }, []);

  return (
    <>
      <div ref={attachAnchor} className="pointer-events-none absolute inset-0" aria-hidden />
      {portal && createPortal(children, portal)}
    </>
  );
}

export function CourseEndLayer({
  overInteractive,
  children,
}: {
  readonly overInteractive: boolean;
  readonly children: ReactNode;
}) {
  const overlay = (
    <motion.div
      className="absolute inset-0 z-[130]"
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      {children}
    </motion.div>
  );

  // The interactive host paints at z-index 1 outside the isolated canvas.
  // Share its portal target so the card covers it without changing the iframe.
  return overInteractive ? (
    <InteractiveCourseEndPortal>{overlay}</InteractiveCourseEndPortal>
  ) : (
    overlay
  );
}
