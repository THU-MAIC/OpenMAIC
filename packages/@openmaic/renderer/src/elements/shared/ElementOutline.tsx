'use client';

import type { PPTElementOutline } from '@openmaic/dsl';
import { useElementOutline } from './useElementOutline';

export interface ElementOutlineProps {
  width: number;
  height: number;
  outline?: PPTElementOutline;
}

export function ElementOutline({ width, height, outline }: ElementOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);

  if (!outline) return null;

  return (
    <svg
      className="element-outline"
      style={{ position: 'absolute', top: 0, left: 0, overflow: 'visible' }}
      width={width}
      height={height}
    >
      <path
        vectorEffect="non-scaling-stroke"
        strokeLinecap="butt"
        strokeMiterlimit="8"
        fill="transparent"
        d={`M0,0 L${width},0 L${width},${height} L0,${height} Z`}
        stroke={outlineColor}
        strokeWidth={outlineWidth}
        strokeDasharray={strokeDashArray}
      />
    </svg>
  );
}
