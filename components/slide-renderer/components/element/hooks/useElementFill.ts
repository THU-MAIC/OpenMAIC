import { useMemo } from 'react';
import type { PPTShapeElement } from '@/lib/types/slides';

/**
 * Calculate element fill style
 * Returns pattern/gradient URL or solid color fill
 * @param element Shape element
 * @param source Source identifier for pattern/gradient IDs
 */
export function useElementFill(element: PPTShapeElement, source: string) {
  const fill = useMemo(() => {
    if (element.pattern) return `url(#${source}-pattern-${element.id})`;
    if (element.gradient) return `url(#${source}-gradient-${element.id})`;
    return element.fill || 'none';
  }, [element.pattern, element.gradient, element.fill, element.id, source]);

  return {
    fill,
  };
}
