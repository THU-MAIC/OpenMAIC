'use client';

import type { PPTElementOutline } from '@/lib/types/slides';
import { useElementOutline } from '../../hooks/useElementOutline';

export interface ImageEllipseOutlineProps {
  width: number;
  height: number;
  outline?: PPTElementOutline;
}

/**
 * Ellipse outline for image element
 */
export function ImageEllipseOutline({ width, height, outline }: ImageEllipseOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);

  if (!outline) return null;

  return (
    <svg className="absolute top-0 left-0 z-[2] overflow-visible" width={width} height={height}>
      <ellipse
        vectorEffect="non-scaling-stroke"
        strokeLinecap="butt"
        strokeMiterlimit="8"
        fill="transparent"
        cx={width / 2}
        cy={height / 2}
        rx={width / 2}
        ry={height / 2}
        stroke={outlineColor}
        strokeWidth={outlineWidth}
        strokeDasharray={strokeDashArray}
      />
    </svg>
  );
}
