import { useLayoutEffect, useRef, useState } from 'react';
import type { Slide } from '@/lib/types/slides';
import { useSlideBackgroundStyle } from '@/lib/hooks/use-slide-background-style';
import { ThumbnailElement } from './ThumbnailElement';

interface ThumbnailSlideProps {
  /** Slide data */
  readonly slide: Slide;
  /**
   * Thumbnail width. When omitted, the thumbnail self-measures and fills its
   * parent's clientWidth via ResizeObserver. Use auto-size in any container
   * that already constrains width via CSS (e.g. `aspect-video w-full`) — this
   * removes the double-signal problem where a JS-computed size prop is
   * recomputed every pointer-tick while a CSS-driven outer container
   * concurrently reflows.
   */
  readonly size?: number;
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
 * Renders a thumbnail preview of a single slide. Uses CSS transform scale to
 * resize the entire view for better performance.
 *
 * Sizing modes:
 *  - **Explicit (`size` prop)**: outer card is sized to `size × size*ratio` px.
 *    Used by playback `SceneSidebar` and `app/page.tsx` outline preview.
 *  - **Auto (no `size` prop)**: outer card fills its parent (`w-full h-full`)
 *    and the internal scale is computed from `ResizeObserver(self.clientWidth)`.
 *    Used by the editor `SlideNavRail` ThumbItem, which sits inside an
 *    `aspect-video w-full` shell and must not depend on a JS-computed size
 *    that re-renders every pointer-tick during rail drag.
 */
export function ThumbnailSlide({
  slide,
  size,
  viewportSize,
  viewportRatio,
  visible = true,
}: ThumbnailSlideProps) {
  const autoSize = size === undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const [observedWidth, setObservedWidth] = useState(0);

  useLayoutEffect(() => {
    if (!autoSize) return;
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      // Avoid React state thrash when the box settles on an identical width.
      setObservedWidth((prev) => (prev === w ? prev : w));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [autoSize]);

  const effectiveWidth = autoSize ? observedWidth : (size ?? 0);
  const scale = effectiveWidth > 0 ? effectiveWidth / viewportSize : 0;

  // Get background style
  const { backgroundStyle } = useSlideBackgroundStyle(slide.background);

  // In auto mode the outer container is CSS-sized (full parent) so any
  // animated outer width from the parent is the single source of truth;
  // we just observe it. In explicit mode we paint a fixed pixel box.
  const containerClass = autoSize
    ? 'thumbnail-slide relative bg-white overflow-hidden select-none pointer-events-none w-full h-full'
    : 'thumbnail-slide bg-white overflow-hidden select-none pointer-events-none';
  const containerStyle: React.CSSProperties | undefined = autoSize
    ? undefined
    : { width: `${size}px`, height: `${(size ?? 0) * viewportRatio}px` };

  if (!visible) {
    return (
      <div ref={containerRef} className={containerClass} style={containerStyle}>
        <div className="placeholder w-full h-full flex justify-center items-center text-gray-400 text-sm">
          加载中 ...
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className={containerClass} style={containerStyle}>
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
