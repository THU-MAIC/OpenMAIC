'use client';

import { useCallback, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'motion/react';
import { visibleClientRect } from '@/lib/edit/visible-client-rect';
import { observeFullscreenPortalTarget } from '@/lib/hooks/use-fullscreen-portal-target';

function SceneCourseEndPortal({ children }: { readonly children: ReactNode }) {
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);

  const attachAnchor = useCallback((anchor: HTMLDivElement | null) => {
    if (!anchor) return;

    // React keeps CourseEnd mounted while its portal container stays the same.
    const layer = document.createElement('div');
    // The interactive host is z-1; an expanded PBL workspace is z-120.
    // The portal itself must outrank both, not only its inner overlay.
    layer.className = 'fixed z-[130] overflow-hidden';
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
  overPortaledScene,
  mobileStage,
  children,
}: {
  readonly overPortaledScene: boolean;
  readonly mobileStage?: Element | null;
  readonly children: ReactNode;
}) {
  const overlay = (
    <motion.div
      className={mobileStage ? 'absolute inset-0 z-[300]' : 'absolute inset-0 z-[130]'}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.18 }}
    >
      {children}
    </motion.div>
  );

  // The phone stage owns its rotation and its full-screen card in the same coordinate space.
  if (mobileStage) return createPortal(overlay, mobileStage);

  // Interactive and PBL scenes paint outside the isolated canvas. Lift only
  // the completion card so the scene and its unsaved runtime state stay mounted.
  return overPortaledScene ? <SceneCourseEndPortal>{overlay}</SceneCourseEndPortal> : overlay;
}
