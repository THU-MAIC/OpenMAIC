'use client';

import type { PPTImageElement } from '@/lib/types/slides';
import { useClipImage } from '../useClipImage';
import { ImageRectOutline } from './image-rect-outline';
import { ImageEllipseOutline } from './image-ellipse-outline';
import { ImagePolygonOutline } from './image-polygon-outline';

export interface ImageOutlineProps {
  elementInfo: PPTImageElement;
}

/**
 * Image outline dispatcher based on clip shape type
 */
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
      {clipShape.type === 'polygon' && (
        <ImagePolygonOutline
          width={elementInfo.width}
          height={elementInfo.height}
          outline={elementInfo.outline}
          createPath={clipShape.createPath!}
        />
      )}
    </div>
  );
}
