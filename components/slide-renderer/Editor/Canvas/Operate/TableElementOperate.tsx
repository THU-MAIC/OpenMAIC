import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTTableElement } from '@/lib/types/slides';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

interface TableElementOperateProps {
  readonly elementInfo: PPTTableElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTTableElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTTableElement,
    command: OperateResizeHandlers,
  ) => void;
}

export function TableElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
}: TableElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();

  const outlineWidth = useMemo(() => elementInfo.outline.width || 1, [elementInfo.outline.width]);

  const scaleWidth = useMemo(
    () => (elementInfo.width + outlineWidth) * canvasScale,
    [elementInfo.width, outlineWidth, canvasScale],
  );
  const scaleHeight = useMemo(
    () => elementInfo.height * canvasScale,
    [elementInfo.height, canvasScale],
  );

  const { resizeHandlers, borderLines } = useCommonOperate(scaleWidth, scaleHeight);

  return (
    <div className="table-element-operate">
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
