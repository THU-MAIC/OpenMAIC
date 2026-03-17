import { useMemo } from 'react';
import type { PPTElementShadow } from '@/lib/types/slides';

/**
 * Calculate element shadow style
 * Converts shadow object to CSS box-shadow string
 * @param shadow Shadow configuration
 */
export function useElementShadow(shadow?: PPTElementShadow) {
  const shadowStyle = useMemo(() => {
    if (shadow) {
      const { h, v, blur, color } = shadow;
      return `${h}px ${v}px ${blur}px ${color}`;
    }
    return '';
  }, [shadow]);

  return {
    shadowStyle,
  };
}
