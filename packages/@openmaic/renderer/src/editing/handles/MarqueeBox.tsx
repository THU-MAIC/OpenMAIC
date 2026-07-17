import type { ViewportStyles } from '../../hooks/useViewportSize';
import type { MarqueeRect } from '../core/marquee';

export interface MarqueeBoxProps {
  /** The live marquee rectangle, normalized in canvas units. */
  rect: MarqueeRect;
  /** SlideCanvas centering offset — the box shares the element container's origin. */
  viewportStyles: ViewportStyles;
  /** Canvas → screen scale (`props.scale ?? fitScale`). */
  canvasScale: number;
}

/**
 * Presentational marquee (rubber-band) rectangle: a dashed border drawn over the
 * canvas while a blank-canvas drag-select is in flight. Props-driven only — the
 * normalized canvas-unit {@link MarqueeRect} is scaled by `canvasScale` and
 * offset by `viewportStyles.left/top` so it lines up with the rendered elements
 * even when the container is letterboxed. Purely visual (`pointerEvents: none`);
 * it never hit-tests. No `@/` imports.
 */
export function MarqueeBox({ rect, viewportStyles, canvasScale }: MarqueeBoxProps) {
  return (
    <div
      data-marquee-box=""
      style={{
        position: 'absolute',
        left: `${viewportStyles.left + rect.minX * canvasScale}px`,
        top: `${viewportStyles.top + rect.minY * canvasScale}px`,
        width: `${(rect.maxX - rect.minX) * canvasScale}px`,
        height: `${(rect.maxY - rect.minY) * canvasScale}px`,
        border: '1px dashed #3b82f6',
        backgroundColor: 'rgba(59, 130, 246, 0.1)',
        boxSizing: 'border-box',
        pointerEvents: 'none',
      }}
    />
  );
}
