'use client';

import type { PPTElementOutline } from '@/lib/types/slides';
import { useElementOutline } from '../../hooks/useElementOutline';

export interface ImagePolygonOutlineProps {
  width: number;
  height: number;
  createPath: (width: number, height: number) => string;
  outline?: PPTElementOutline;
}

/**
 * Polygon outline for image element
 */
export function ImagePolygonOutline({
  width,
  height,
  createPath,
  outline,
}: ImagePolygonOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);

  if (!outline) return null;

  return (
    <svg className="absolute top-0 left-0 z-[2] overflow-visible" width={width} height={height}>
      <path
        vectorEffect="non-scaling-stroke"
        strokeLinecap="butt"
        strokeMiterlimit="8"
        fill="transparent"
        d={createPath(width, height)}
        stroke={outlineColor}
        strokeWidth={outlineWidth}
        strokeDasharray={strokeDashArray}
      />
    </svg>
  );
}
