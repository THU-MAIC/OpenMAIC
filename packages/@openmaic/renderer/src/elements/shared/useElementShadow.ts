import { useMemo } from 'react';
import type { PPTElementShadow } from '@openmaic/dsl';

export function useElementShadow(shadow?: PPTElementShadow) {
  const shadowStyle = useMemo(() => {
    if (shadow) {
      const { h, v, blur, color } = shadow;
      return `${h}px ${v}px ${blur}px ${color}`;
    }
    return '';
  }, [shadow]);

  return { shadowStyle };
}
