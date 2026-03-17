import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type {
  PPTVideoElement,
  PPTLatexElement,
  PPTAudioElement,
  PPTChartElement,
} from '@/lib/types/slides';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

type PPTElement = PPTVideoElement | PPTLatexElement | PPTAudioElement | PPTChartElement;

interface CommonElementOperateProps {
  readonly elementInfo: PPTElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTElement,
    command: OperateResizeHandlers,
  ) => void;
}

export function CommonElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
}: CommonElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();

  const scaleWidth = useMemo(
    () => elementInfo.width * canvasScale,
    [elementInfo.width, canvasScale],
  );
  const scaleHeight = useMemo(
    () => elementInfo.height * canvasScale,
    [elementInfo.height, canvasScale],
  );
  const { resizeHandlers, borderLines } = useCommonOperate(scaleWidth, scaleHeight);

  const cannotRotate = useMemo(
    () => ['chart', 'video', 'audio'].includes(elementInfo.type),
    [elementInfo.type],
  );

  return (
    <div className="common-element-operate">
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
          {!cannotRotate && (
            <RotateHandler
              className="operate-rotate-handler"
              style={{ left: scaleWidth / 2 + 'px' }}
              onMouseDown={(e) => {
                e.stopPropagation();
                rotateElement(e, elementInfo);
              }}
            />
          )}
        </>
      )}
    </div>
  );
}
