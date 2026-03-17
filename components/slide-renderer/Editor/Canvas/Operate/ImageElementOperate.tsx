import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTImageElement } from '@/lib/types/slides';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

interface ImageElementOperateProps {
  readonly elementInfo: PPTImageElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTImageElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTImageElement,
    command: OperateResizeHandlers,
  ) => void;
}

export function ImageElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
}: ImageElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const clipingImageElementId = useCanvasStore.use.clipingImageElementId();

  const isCliping = useMemo(
    () => clipingImageElementId === elementInfo.id,
    [clipingImageElementId, elementInfo.id],
  );

  const scaleWidth = useMemo(
    () => elementInfo.width * canvasScale,
    [elementInfo.width, canvasScale],
  );
  const scaleHeight = useMemo(
    () => elementInfo.height * canvasScale,
    [elementInfo.height, canvasScale],
  );
  const { resizeHandlers, borderLines } = useCommonOperate(scaleWidth, scaleHeight);

  return (
    <div className={`image-element-operate ${isCliping ? 'invisible' : ''}`}>
      {borderLines.map((line) => (
        <BorderLine
          key={line.type}
          type={line.type}
          style={line.style}
          className="operate-border-line"
        />
      ))}
      {handlerVisible && (
        <>
          {resizeHandlers.map((point) => (
            <ResizeHandler
              key={point.direction}
              type={point.direction}
              rotate={elementInfo.rotate}
              style={point.style}
              className="operate-resize-handler"
              onMouseDown={(e) => {
                e.stopPropagation();
                scaleElement(e, elementInfo, point.direction);
              }}
            />
          ))}
          <RotateHandler
            className="operate-rotate-handler"
            style={{ left: scaleWidth / 2 + 'px' }}
            onMouseDown={(e) => {
              e.stopPropagation();
              rotateElement(e, elementInfo);
            }}
          />
        </>
      )}
    </div>
  );
}
