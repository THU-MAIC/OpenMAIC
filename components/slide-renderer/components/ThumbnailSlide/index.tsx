import { useMemo } from 'react';
import type { Slide } from '@/lib/types/slides';
import { useSlideBackgroundStyle } from '@/lib/hooks/use-slide-background-style';
import { ThumbnailElement } from './ThumbnailElement';

interface ThumbnailSlideProps {
  /** Slide data */
  readonly slide: Slide;
  /** Thumbnail width */
  readonly size: number;
  /** Viewport width base (default 1000px) */
  readonly viewportSize: number;
  /** Viewport aspect ratio (default 0.5625 i.e. 16:9) */
  readonly viewportRatio: number;
  /** Whether visible (for lazy loading optimization) */
  readonly visible?: boolean;
}

/**
 * Thumbnail slide component
 *
 * Renders a thumbnail preview of a single slide
 * Uses CSS transform scale to resize the entire view for better performance
 */
export function ThumbnailSlide({
  slide,
  size,
  viewportSize,
  viewportRatio,
  visible = true,
}: ThumbnailSlideProps) {
  // Calculate scale ratio
  const scale = useMemo(() => size / viewportSize, [size, viewportSize]);

  // Get background style
  const { backgroundStyle } = useSlideBackgroundStyle(slide.background);

  if (!visible) {
    return (
      <div
        className="thumbnail-slide bg-white overflow-hidden select-none"
        style={{
          width: `${size}px`,
          height: `${size * viewportRatio}px`,
        }}
      >
        <div className="placeholder w-full h-full flex justify-center items-center text-gray-400 text-sm">
          加载中 ...
        </div>
      </div>
    );
  }

  return (
    <div
      className="thumbnail-slide bg-white overflow-hidden select-none"
      style={{
        width: `${size}px`,
        height: `${size * viewportRatio}px`,
      }}
    >
      <div
        className="elements origin-top-left"
        style={{
          width: `${viewportSize}px`,
          height: `${viewportSize * viewportRatio}px`,
          transform: `scale(${scale})`,
        }}
      >
        {/* Background */}
        <div className="background w-full h-full bg-center absolute" style={backgroundStyle} />

        {/* Render all elements */}
        {slide.elements.map((element, index) => (
          <ThumbnailElement key={element.id} elementInfo={element} elementIndex={index + 1} />
        ))}
      </div>
    </div>
  );
}
