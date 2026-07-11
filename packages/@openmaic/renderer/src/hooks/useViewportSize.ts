import { useState, useEffect, useMemo, useCallback, type RefObject } from 'react';

export interface ViewportStyles {
  width: number;
  height: number;
  left: number;
  top: number;
}

export interface UseViewportSizeResult {
  viewportStyles: ViewportStyles;
  /** Computed scale: viewport pixels → container pixels at the current fit. */
  fitScale: number;
}

export interface UseViewportSizeOptions {
  /** Viewport width in design pixels (slide.viewportSize), default 1000 */
  viewportSize?: number;
  /** Viewport aspect ratio (slide.viewportRatio), default 0.5625 (16:9) */
  viewportRatio?: number;
  /** Percent of the container the viewport should occupy, default 100 */
  canvasPercentage?: number;
}

/**
 * Compute the viewport rect and fit-scale needed to center a slide of size
 * `viewportSize × viewportSize*viewportRatio` inside `canvasRef`.
 *
 * Pure: no store access. Re-runs on container resize via ResizeObserver.
 */
export function useViewportSize(
  canvasRef: RefObject<HTMLElement | null>,
  options: UseViewportSizeOptions = {},
): UseViewportSizeResult {
  const { viewportSize = 1000, viewportRatio = 0.5625, canvasPercentage = 100 } = options;

  const [viewportLeft, setViewportLeft] = useState(0);
  const [viewportTop, setViewportTop] = useState(0);
  const [fitScale, setFitScale] = useState(1);

  const computeFit = useCallback(() => {
    if (!canvasRef.current) return;
    const canvasWidth = canvasRef.current.clientWidth;
    const canvasHeight = canvasRef.current.clientHeight;

    if (canvasHeight / canvasWidth > viewportRatio) {
      const viewportActualWidth = canvasWidth * (canvasPercentage / 100);
      setFitScale(viewportActualWidth / viewportSize);
      setViewportLeft((canvasWidth - viewportActualWidth) / 2);
      setViewportTop((canvasHeight - viewportActualWidth * viewportRatio) / 2);
    } else {
      const viewportActualHeight = canvasHeight * (canvasPercentage / 100);
      setFitScale(viewportActualHeight / (viewportSize * viewportRatio));
      setViewportLeft((canvasWidth - viewportActualHeight / viewportRatio) / 2);
      setViewportTop((canvasHeight - viewportActualHeight) / 2);
    }
  }, [canvasRef, canvasPercentage, viewportRatio, viewportSize]);

  useEffect(() => {
    computeFit();
  }, [computeFit]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const resizeObserver = new ResizeObserver(computeFit);
    resizeObserver.observe(el);
    return () => resizeObserver.unobserve(el);
  }, [canvasRef, computeFit]);

  const viewportStyles: ViewportStyles = useMemo(
    () => ({
      width: viewportSize,
      height: viewportSize * viewportRatio,
      left: viewportLeft,
      top: viewportTop,
    }),
    [viewportSize, viewportRatio, viewportLeft, viewportTop],
  );

  return { viewportStyles, fitScale };
}
