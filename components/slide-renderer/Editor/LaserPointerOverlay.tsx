'use client';

import { useRef, useState, useLayoutEffect, useCallback } from 'react';
import { measureSpotlightRect } from '@openmaic/renderer';
import { AnimatePresence } from 'motion/react';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { useCanvasStore } from '@/lib/store/canvas';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement } from '@openmaic/dsl';
import { LaserOverlay } from './LaserOverlay';
import { SCREEN_ELEMENT_ID_PREFIX } from '../element-dom';

interface LaserPointerOverlayProps {
  /**
   * DOM id prefix used to locate the target element. Playback screens render
   * elements as `screen-element-<id>` (default); the editor canvas renders
   * them as `editable-element-<id>` and passes that prefix so a `laser` cue
   * replays as the real laser pointer in Pro mode.
   */
  domIdPrefix?: string;
}

/**
 * Store-driven laser pointer overlay.
 *
 * The laser sibling of {@link SpotlightOverlay}: reads `laserElementId` /
 * `laserOptions` from the canvas store and measures the rendered DOM element
 * (`getBoundingClientRect`) to place the laser dot at its center. Without this,
 * the edit canvas had no laser surface, so laser cues had nowhere to render and
 * were collapsed into a spotlight instead.
 */
export function LaserPointerOverlay({
  domIdPrefix = SCREEN_ELEMENT_ID_PREFIX,
}: LaserPointerOverlayProps = {}) {
  const laserElementId = useCanvasStore.use.laserElementId();
  const laserOptions = useCanvasStore.use.laserOptions();
  const containerRef = useRef<HTMLDivElement>(null);
  const [center, setCenter] = useState<{ x: number; y: number } | null>(null);

  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );

  // Compute the target element center as a percentage of the overlay container.
  const measure = useCallback(() => {
    if (!laserElementId || !containerRef.current) {
      setCenter(null);
      return;
    }

    const domElement = document.getElementById(`${domIdPrefix}${laserElementId}`);
    if (!domElement) {
      setCenter(null);
      return;
    }

    // Prefer .element-content (the actual rendered area for auto-height).
    const contentEl = domElement.querySelector('.element-content');
    const targetEl = contentEl ?? domElement;

    const rect = measureSpotlightRect(containerRef.current, targetEl);
    setCenter(rect ? { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 } : null);
  }, [laserElementId, domIdPrefix]);

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM measurement requires effect
    measure();
    const container = containerRef.current;
    const root = laserElementId && document.getElementById(domIdPrefix + laserElementId);
    if (!container || !root) return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    observer.observe(root.querySelector('.element-content') ?? root);
    return () => observer.disconnect();
  }, [measure, elements, laserElementId, domIdPrefix]);

  return (
    // No overflow-hidden: the laser flies in from just outside the frame.
    <div ref={containerRef} className="absolute inset-0 z-[101] pointer-events-none">
      <AnimatePresence>
        {laserElementId && center && (
          <LaserOverlay
            key={`laser-${laserElementId}`}
            geometry={{ x: 0, y: 0, w: 0, h: 0, centerX: center.x, centerY: center.y }}
            color={laserOptions?.color}
            duration={laserOptions?.duration}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
