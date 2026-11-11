'use client';

import { ScreenElement } from './ScreenElement';
import { HighlightOverlay } from './HighlightOverlay';
import { SpotlightOverlay } from './SpotlightOverlay';
import { LaserPointerOverlay } from './LaserPointerOverlay';
import { RendererScreenCanvas } from './RendererScreenCanvas';
import { useSlideBackgroundStyle } from '@/lib/hooks/use-slide-background-style';
import { useCanvasStore } from '@/lib/store';
import { useSyncCanvasViewportFromSlide } from '@/lib/store/sync-canvas-viewport';
import { useSceneSelector } from '@/lib/contexts/scene-context';
import { findElementGeometry } from '@/lib/utils/geometry';
import type { SlideContent } from '@/lib/types/stage';
import type { PPTElement, SlideBackground } from '@openmaic/dsl';
import type { PercentageGeometry } from '@/lib/types/action';
import { useViewportSize } from './Canvas/hooks/useViewportSize';
import { useRef, useMemo } from 'react';
import { isPlaybackRendererEnabled } from '@/lib/config/feature-flags';
import { createTextProseStyles } from '@openmaic/renderer';

const LEGACY_SHAPE_PROSE_STYLES = createTextProseStyles(
  '.legacy-screen-canvas .screen-element .slide-renderer-prose',
);

export function ScreenCanvas() {
  useSyncCanvasViewportFromSlide();
  const canvasScale = useCanvasStore.use.canvasScale();
  const elements = useSceneSelector<SlideContent, PPTElement[]>(
    (content) => content.canvas.elements,
  );
  const canvasRef = useRef<HTMLDivElement>(null);

  // Viewport size and positioning
  const { viewportStyles } = useViewportSize(canvasRef);

  // Get background style
  const background = useSceneSelector<SlideContent, SlideBackground | undefined>(
    (content) => content.canvas.background,
  );
  const { backgroundStyle } = useSlideBackgroundStyle(background);

  // Get visual effect state
  const zoomTarget = useCanvasStore.use.zoomTarget();
  const viewportSize = useCanvasStore.use.viewportSize();
  const viewportRatio = useCanvasStore.use.viewportRatio();

  // Compute zoom target geometry against the slide's own viewport (not the
  // 1000px default), so zoom centers on the element for any slide size.
  const zoomGeometry = useMemo<PercentageGeometry | null>(() => {
    if (!zoomTarget) return null;
    return findElementGeometry(
      { type: 'slide', content: { canvas: { elements } } } as Record<string, unknown>,
      zoomTarget.elementId,
      viewportSize,
      viewportRatio,
    );
  }, [zoomTarget, elements, viewportSize, viewportRatio]);

  return (
    <div
      className="legacy-screen-canvas relative h-full w-full overflow-hidden select-none"
      ref={canvasRef}
    >
      <style dangerouslySetInnerHTML={{ __html: LEGACY_SHAPE_PROSE_STYLES }} />
      <div
        className="absolute shadow-[0_0_0_1px_rgba(0,0,0,0.01),0_0_12px_0_rgba(0,0,0,0.1)] rounded-lg overflow-hidden transition-transform duration-700"
        style={{
          width: `${viewportStyles.width * canvasScale}px`,
          height: `${viewportStyles.height * canvasScale}px`,
          left: `${viewportStyles.left}px`,
          top: `${viewportStyles.top}px`,
          ...(zoomTarget && zoomGeometry
            ? {
                transform: `scale(${zoomTarget.scale})`,
                transformOrigin: `${zoomGeometry.centerX}% ${zoomGeometry.centerY}%`,
              }
            : {}),
        }}
      >
        {/* Background layer */}
        <div
          className="w-full h-full bg-position-center rounded-lg"
          style={{ ...backgroundStyle }}
        ></div>

        {/* Content layer - scaled */}
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: `${viewportStyles.width}px`,
            height: `${viewportStyles.height}px`,
            transform: `scale(${canvasScale})`,
          }}
        >
          {elements.map((element, index) => (
            <ScreenElement key={element.id} elementInfo={element} elementIndex={index + 1} />
          ))}

          {/* Highlight overlay - stacked above elements */}
          <HighlightOverlay />
        </div>

        {/* Spotlight overlay - covers the entire slide, positioned via DOM measurement */}
        <SpotlightOverlay />

        {/* Laser pointer - placed on the measured DOM element, like the editor */}
        <LaserPointerOverlay />
      </div>
    </div>
  );
}

export function PlaybackScreenCanvas() {
  return isPlaybackRendererEnabled() ? <RendererScreenCanvas /> : <ScreenCanvas />;
}
