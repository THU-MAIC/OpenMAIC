import { useMemo } from 'react';
import { ElementTypes, type PPTElement, type PPTVideoElement } from '@/lib/types/slides';
import { isMediaPlaceholder } from '@/lib/store/media-generation';
import { Play } from 'lucide-react';

import { BaseImageElement } from '../element/ImageElement/BaseImageElement';
import { BaseTextElement } from '../element/TextElement/BaseTextElement';
import { BaseShapeElement } from '../element/ShapeElement/BaseShapeElement';
import { BaseLineElement } from '../element/LineElement/BaseLineElement';
import { BaseChartElement } from '../element/ChartElement/BaseChartElement';
import { BaseLatexElement } from '../element/LatexElement/BaseLatexElement';
import { BaseTableElement } from '../element/TableElement/BaseTableElement';

interface ThumbnailElementProps {
  readonly elementInfo: PPTElement;
  readonly elementIndex: number;
}

function ThumbnailVideoIndicator() {
  return (
    <div
      className="absolute inset-0 flex items-center justify-center pointer-events-none"
      data-testid="thumbnail-video-indicator"
    >
      <div className="flex size-28 items-center justify-center rounded-full bg-black/45 shadow-lg ring-2 ring-white/85">
        <Play className="ml-1 size-14 fill-white text-white" />
      </div>
    </div>
  );
}

function ThumbnailVideoElement({ elementInfo }: { readonly elementInfo: PPTVideoElement }) {
  const src = elementInfo.src && !isMediaPlaceholder(elementInfo.src) ? elementInfo.src : undefined;

  return (
    <div
      className="element-content absolute"
      data-video-element
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div className="w-full h-full" style={{ transform: `rotate(${elementInfo.rotate}deg)` }}>
        {src && (
          <video
            className="w-full h-full"
            style={{ objectFit: 'contain' }}
            src={src}
            poster={elementInfo.poster}
            preload="metadata"
            muted
            playsInline
          />
        )}
        {!src && <div className="w-full h-full bg-black/10 rounded" />}
        <ThumbnailVideoIndicator />
      </div>
    </div>
  );
}

/**
 * Thumbnail element component
 *
 * Renders the corresponding Base component based on element type
 */
export function ThumbnailElement({ elementInfo, elementIndex }: ThumbnailElementProps) {
  const CurrentElementComponent = useMemo(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- element components have varying prop signatures
    const elementTypeMap: Record<string, any> = {
      [ElementTypes.IMAGE]: BaseImageElement,
      [ElementTypes.TEXT]: BaseTextElement,
      [ElementTypes.SHAPE]: BaseShapeElement,
      [ElementTypes.LINE]: BaseLineElement,
      [ElementTypes.CHART]: BaseChartElement,
      [ElementTypes.LATEX]: BaseLatexElement,
      [ElementTypes.TABLE]: BaseTableElement,
      // TODO: Add other element types
      [ElementTypes.VIDEO]: ThumbnailVideoElement,
      // [ElementTypes.AUDIO]: BaseAudioElement,
    };
    return elementTypeMap[elementInfo.type] || null;
  }, [elementInfo.type]);

  if (!CurrentElementComponent) {
    return null;
  }

  return (
    <div
      className={`base-element base-element-${elementInfo.id}`}
      style={{
        zIndex: elementIndex,
      }}
    >
      <CurrentElementComponent elementInfo={elementInfo} target="thumbnail" />
    </div>
  );
}
