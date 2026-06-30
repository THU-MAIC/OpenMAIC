import { useMemo } from 'react';
import type { PPTElementOutline } from '@openmaic/dsl';

export function useElementOutline(outline?: PPTElementOutline) {
  const outlineWidth = useMemo(() => outline?.width ?? 0, [outline?.width]);
  const outlineStyle = useMemo(() => outline?.style || 'solid', [outline?.style]);
  const outlineColor = useMemo(() => outline?.color || '#d14424', [outline?.color]);

  const strokeDashArray = useMemo(() => {
    const size = outlineWidth;
    if (outlineStyle === 'dashed')
      return size <= 6 ? `${size * 4.5} ${size * 2}` : `${size * 4} ${size * 1.5}`;
    if (outlineStyle === 'dotted')
      return size <= 6 ? `${size * 1.8} ${size * 1.6}` : `${size * 1.5} ${size * 1.2}`;
    return '0 0';
  }, [outlineWidth, outlineStyle]);

  return { outlineWidth, outlineStyle, outlineColor, strokeDashArray };
}
