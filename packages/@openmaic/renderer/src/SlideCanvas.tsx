'use client';

import { useRef, type CSSProperties, type ReactNode } from 'react';
import { AnimatePresence } from 'motion/react';

import type {
  PPTElement,
  PPTImageElement,
  PPTVideoElement,
  Slide,
  SlideBackground,
} from '@openmaic/dsl';
import type { SlideEffects } from './types/effects';
import { findElementGeometry, type PercentageGeometry } from './utils/geometry';
import { useSlideBackgroundStyle } from './hooks/useSlideBackgroundStyle';
import { useViewportSize } from './hooks/useViewportSize';
import { SlideElement } from './SlideElement';
import { HighlightOverlay } from './effects/HighlightOverlay';
import { SpotlightOverlay } from './effects/SpotlightOverlay';
import { LaserOverlay } from './effects/LaserOverlay';
import { useOptionalSlideContext } from './context';
import { SLIDE_RENDERER_STYLES } from './styles';

export interface SlideCanvasProps {
  /**
   * Single slide data (PPTist-style). May be omitted when this component is
   * rendered inside a `<SlideRendererProvider>` that supplies it.
   */
  slide?: Slide;
  /**
   * Canvas scale. When omitted, the canvas auto-fits the container using
   * `slide.viewportSize` and `slide.viewportRatio`. Set to a fixed number
   * (e.g. 1) to skip auto-fit and render at slide-native dimensions.
   */
  scale?: number;
  /** Override `slide.background`. */
  background?: SlideBackground;
  /** Optional play-time effects, all default off. */
  effects?: SlideEffects;
  /** Replace default <img> rendering for image elements. */
  renderImage?: (element: PPTImageElement, resolvedSrc: string) => ReactNode;
  /** Replace default <video> rendering for video elements. */
  renderVideo?: (element: PPTVideoElement) => ReactNode;
  /** Click handler invoked on any element. */
  onElementClick?: (element: PPTElement, event: React.MouseEvent) => void;
  /** Class on the outer container. */
  className?: string;
  /** Inline style on the outer container. */
  style?: CSSProperties;
  /**
   * Card-style chrome on the inner slide container (drop shadow + rounded
   * corners). Defaults to `true` for on-screen previews. Snapshot pipelines
   * pass `false` so the captured PNG matches the source PPT's edges exactly
   * — html2canvas would otherwise bake the 1px shadow outline and the
   * 0.5rem corner radius into the output and the comparator reads them as
   * a thin border + rounded corners that the original PPT does not have.
   */
  chrome?: boolean;
}

export function SlideCanvas(props: SlideCanvasProps) {
  const ctx = useOptionalSlideContext();
  const slide = props.slide ?? ctx?.slide;
  if (!slide) {
    throw new Error(
      '<SlideCanvas> requires `slide` either as a prop or via <SlideRendererProvider>.',
    );
  }

  const scale = props.scale ?? ctx?.scale;
  const background = props.background ?? ctx?.background;
  const effects = props.effects ?? ctx?.effects;
  const renderImage = props.renderImage ?? ctx?.renderImage;
  const renderVideo = props.renderVideo ?? ctx?.renderVideo;
  const onElementClick = props.onElementClick ?? ctx?.onElementClick;
  const { className, style } = props;
  const chrome = props.chrome ?? true;

  const canvasRef = useRef<HTMLDivElement>(null);
  const elements = slide.elements;

  const { viewportStyles, fitScale } = useViewportSize(canvasRef, {
    viewportSize: slide.viewportSize,
    viewportRatio: slide.viewportRatio,
  });
  const canvasScale = scale ?? fitScale;

  const resolvedBackground = background ?? slide.background;
  const { backgroundStyle } = useSlideBackgroundStyle(resolvedBackground);

  // Plain derivations: when this package is consumed in a React Compiler build
  // these are auto-memoized; otherwise the cost (O(elements) lookups) is trivial.
  const laserGeometry: PercentageGeometry | null = effects?.laser
    ? findElementGeometry(elements, effects.laser.elementId, slide.viewportSize)
    : null;

  const zoomGeometry: PercentageGeometry | null = effects?.zoom
    ? findElementGeometry(elements, effects.zoom.elementId, slide.viewportSize)
    : null;

  const highlightElement = effects?.highlight
    ? (elements.find((el) => el.id === effects.highlight!.elementId) ?? null)
    : null;

  return (
    <div
      ref={canvasRef}
      className={className}
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        userSelect: 'none',
        ...style,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: SLIDE_RENDERER_STYLES }} />
      <div
        style={{
          position: 'absolute',
          ...(chrome
            ? {
                boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.01), 0 0 12px 0 rgba(0, 0, 0, 0.1)',
                borderRadius: '0.5rem',
              }
            : {}),
          overflow: 'hidden',
          transitionProperty: 'transform',
          transitionDuration: '700ms',
          width: `${viewportStyles.width * canvasScale}px`,
          height: `${viewportStyles.height * canvasScale}px`,
          left: `${viewportStyles.left}px`,
          top: `${viewportStyles.top}px`,
          ...(effects?.zoom && zoomGeometry
            ? {
                transform: `scale(${effects.zoom.scale})`,
                transformOrigin: `${zoomGeometry.centerX}% ${zoomGeometry.centerY}%`,
              }
            : {}),
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            backgroundPosition: 'center',
            ...(chrome ? { borderRadius: '0.5rem' } : {}),
            ...backgroundStyle,
          }}
        />

        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            transformOrigin: 'top left',
            width: `${viewportStyles.width}px`,
            height: `${viewportStyles.height}px`,
            transform: `scale(${canvasScale})`,
          }}
        >
          {elements.map((element, index) => (
            <SlideElement
              key={element.id}
              elementInfo={element}
              elementIndex={index + 1}
              theme={slide.theme}
              renderImage={renderImage}
              renderVideo={renderVideo}
              onElementClick={onElementClick}
            />
          ))}

          {highlightElement && (
            <HighlightOverlay element={highlightElement} options={effects?.highlight} />
          )}
        </div>

        <SpotlightOverlay options={effects?.spotlight} />

        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            padding: '5%',
          }}
        >
          <div style={{ position: 'relative', width: '100%', height: '100%' }}>
            <AnimatePresence>
              {effects?.laser && laserGeometry && (
                <LaserOverlay
                  key={`laser-${effects.laser.elementId}`}
                  geometry={laserGeometry}
                  color={effects.laser.color}
                  duration={effects.laser.duration}
                />
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
