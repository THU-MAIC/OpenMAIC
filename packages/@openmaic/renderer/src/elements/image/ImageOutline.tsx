'use client';

import type { PPTElementOutline, PPTImageElement } from '@openmaic/dsl';
import { useElementOutline } from '../shared/useElementOutline';
import { useClipImage } from './useClipImage';

export interface ImageOutlineProps {
  elementInfo: PPTImageElement;
}

interface ImageRectOutlineProps {
  width: number;
  height: number;
  outline?: PPTElementOutline;
  radius?: string;
}

function ImageRectOutline({ width, height, outline, radius = '0' }: ImageRectOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);
  if (!outline) return null;
  return (
    <svg
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 2, overflow: 'visible' }}
      width={width}
      height={height}
    >
      <rect
        vectorEffect="non-scaling-stroke"
        strokeLinecap="butt"
        strokeMiterlimit="8"
        fill="transparent"
        rx={radius}
        ry={radius}
        width={width}
        height={height}
        stroke={outlineColor}
        strokeWidth={outlineWidth}
        strokeDasharray={strokeDashArray}
      />
    </svg>
  );
}

interface ImageEllipseOutlineProps {
  width: number;
  height: number;
  outline?: PPTElementOutline;
}

function ImageEllipseOutline({ width, height, outline }: ImageEllipseOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);
  if (!outline) return null;
  return (
    <svg
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 2, overflow: 'visible' }}
      width={width}
      height={height}
    >
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

interface ImagePolygonOutlineProps {
  width: number;
  height: number;
  createPath: (width: number, height: number) => string;
  outline?: PPTElementOutline;
}

function ImagePolygonOutline({ width, height, createPath, outline }: ImagePolygonOutlineProps) {
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(outline);
  if (!outline) return null;
  return (
    <svg
      style={{ position: 'absolute', top: 0, left: 0, zIndex: 2, overflow: 'visible' }}
      width={width}
      height={height}
    >
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

export function ImageOutline({ elementInfo }: ImageOutlineProps) {
  const { clipShape } = useClipImage(elementInfo);

  return (
    <div className="image-outline">
      {clipShape.type === 'rect' && (
        <ImageRectOutline
          width={elementInfo.width}
          height={elementInfo.height}
          radius={clipShape.radius}
          outline={elementInfo.outline}
        />
      )}
      {clipShape.type === 'ellipse' && (
        <ImageEllipseOutline
          width={elementInfo.width}
          height={elementInfo.height}
          outline={elementInfo.outline}
        />
      )}
      {clipShape.type === 'polygon' && clipShape.createPath && (
        <ImagePolygonOutline
          width={elementInfo.width}
          height={elementInfo.height}
          outline={elementInfo.outline}
          createPath={clipShape.createPath}
        />
      )}
    </div>
  );
}
