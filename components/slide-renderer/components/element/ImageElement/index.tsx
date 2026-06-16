'use client';

import type { PPTImageElement, ImageElementClip } from '@maic/dsl';
import type { ImageClipedEmitData } from '@/lib/types/edit';
import { useCanvasStore } from '@/lib/store';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { useElementShadow } from '../hooks/useElementShadow';
import { useElementFlip } from '../hooks/useElementFlip';
import { useClipImage } from './useClipImage';
import { useFilter } from './useFilter';
import { ImageOutline } from './ImageOutline';
import { ImageClipHandler } from './ImageClipHandler';
import { useResolvedImageSrc } from './useResolvedImageSrc';

export interface ImageElementProps {
  elementInfo: PPTImageElement;
  selectElement?: (e: React.MouseEvent | React.TouchEvent, element: PPTImageElement) => void;
}

/**
 * Image element component with interaction support
 */
export function ImageElement({ elementInfo, selectElement }: ImageElementProps) {
  const clipingImageElementId = useCanvasStore.use.clipingImageElementId();
  const setClipingImageElementId = useCanvasStore.use.setClipingImageElementId();
  const { updateElement } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();

  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);
  const { clipShape, imgPosition } = useClipImage(elementInfo);
  const { filter } = useFilter(elementInfo.filters);

  // Resolve gen_img_* placeholders against the media generation store so the
  // editor canvas displays the generated image (the read-only BaseImageElement
  // has always done this; the interactive variant previously rendered the raw
  // placeholder string, surfacing a broken-image icon in Pro mode).
  const { resolvedSrc } = useResolvedImageSrc(elementInfo);

  const isCliping = clipingImageElementId === elementInfo.id;

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo);
  };

  const handleClip = (data: ImageClipedEmitData | null) => {
    setClipingImageElementId('');

    if (!data) return;

    const { range, position } = data;
    const originClip: ImageElementClip = elementInfo.clip || {
      shape: 'rect',
      range: [
        [0, 0],
        [100, 100],
      ],
    };

    const left = elementInfo.left + position.left;
    const top = elementInfo.top + position.top;
    const width = elementInfo.width + position.width;
    const height = elementInfo.height + position.height;

    let centerOffsetX = 0;
    let centerOffsetY = 0;

    if (elementInfo.rotate) {
      const centerX = left + width / 2 - (elementInfo.left + elementInfo.width / 2);
      const centerY = -(top + height / 2 - (elementInfo.top + elementInfo.height / 2));

      const radian = (-elementInfo.rotate * Math.PI) / 180;

      const rotatedCenterX = centerX * Math.cos(radian) - centerY * Math.sin(radian);
      const rotatedCenterY = centerX * Math.sin(radian) + centerY * Math.cos(radian);

      centerOffsetX = rotatedCenterX - centerX;
      centerOffsetY = -(rotatedCenterY - centerY);
    }

    const props = {
      clip: { ...originClip, range },
      left: left + centerOffsetX,
      top: top + centerOffsetY,
      width,
      height,
    };
    updateElement({ id: elementInfo.id, props });

    addHistorySnapshot();
  };

  return (
    <div
      className={`editable-element-image absolute ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        {isCliping ? (
          <ImageClipHandler
            src={resolvedSrc}
            clipData={elementInfo.clip}
            width={elementInfo.width}
            height={elementInfo.height}
            top={elementInfo.top}
            left={elementInfo.left}
            rotate={elementInfo.rotate}
            clipPath={clipShape.style}
            onClip={handleClip}
          />
        ) : (
          <div
            className={`element-content w-full h-full relative ${elementInfo.lock ? '' : 'cursor-move'}`}
            style={{
              filter: shadowStyle ? `drop-shadow(${shadowStyle})` : '',
              transform: flipStyle,
            }}
            onMouseDown={handleSelectElement}
            onTouchStart={handleSelectElement}
          >
            <ImageOutline elementInfo={elementInfo} />

            <div
              className="image-content w-full h-full overflow-hidden relative"
              style={{ clipPath: clipShape.style }}
            >
              <img
                src={resolvedSrc}
                draggable={false}
                style={{
                  position: 'absolute',
                  top: imgPosition.top,
                  left: imgPosition.left,
                  width: imgPosition.width,
                  height: imgPosition.height,
                  filter,
                }}
                alt=""
                onDragStart={(e) => e.preventDefault()}
              />
              {elementInfo.colorMask && (
                <div
                  className="color-mask absolute inset-0"
                  style={{
                    backgroundColor: elementInfo.colorMask,
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
