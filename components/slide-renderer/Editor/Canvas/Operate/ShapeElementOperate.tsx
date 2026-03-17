import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTShapeElement } from '@/lib/types/slides';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { SHAPE_PATH_FORMULAS } from '@/configs/shapes';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

interface ShapeElementOperateProps {
  readonly elementInfo: PPTShapeElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTShapeElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTShapeElement,
    command: OperateResizeHandlers,
  ) => void;
  readonly moveShapeKeypoint: (
    e: React.MouseEvent,
    element: PPTShapeElement,
    index: number,
  ) => void;
}

export function ShapeElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
  moveShapeKeypoint,
}: ShapeElementOperateProps) {
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

  const keypoints = useMemo(() => {
    if (!elementInfo.pathFormula || elementInfo.keypoints === undefined) return [];
    const pathFormula = SHAPE_PATH_FORMULAS[elementInfo.pathFormula];

    return elementInfo.keypoints.map((keypoint, index) => {
      const getBaseSize = pathFormula.getBaseSize![index];
      const relative = pathFormula.relative![index];
      const keypointPos = getBaseSize(elementInfo.width, elementInfo.height) * keypoint;

      let styles: React.CSSProperties = {};
      if (relative === 'left') styles = { left: keypointPos * canvasScale + 'px' };
      else if (relative === 'right')
        styles = {
          left: (elementInfo.width - keypointPos) * canvasScale + 'px',
        };
      else if (relative === 'center')
        styles = {
          left: ((elementInfo.width - keypointPos) / 2) * canvasScale + 'px',
        };
      else if (relative === 'top') styles = { top: keypointPos * canvasScale + 'px' };
      else if (relative === 'bottom')
        styles = {
          top: (elementInfo.height - keypointPos) * canvasScale + 'px',
        };
      else if (relative === 'left_bottom')
        styles = {
          left: keypointPos * canvasScale + 'px',
          top: elementInfo.height * canvasScale + 'px',
        };
      else if (relative === 'right_bottom')
        styles = {
          left: (elementInfo.width - keypointPos) * canvasScale + 'px',
          top: elementInfo.height * canvasScale + 'px',
        };
      else if (relative === 'top_right')
        styles = {
          left: elementInfo.width * canvasScale + 'px',
          top: keypointPos * canvasScale + 'px',
        };
      else if (relative === 'bottom_right')
        styles = {
          left: elementInfo.width * canvasScale + 'px',
          top: (elementInfo.height - keypointPos) * canvasScale + 'px',
        };

      return {
        keypoint,
        styles,
      };
    });
  }, [elementInfo, canvasScale]);

  return (
    <div className="shape-element-operate">
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
          {keypoints.map((keypoint, index) => (
            <div
              key={index}
              className="operate-keypoint-handler absolute w-[10px] h-[10px] left-0 top-0 m-[-5px_0_0_-5px] border border-primary bg-[#ffe873] rounded-[1px]"
              style={keypoint.styles}
              onMouseDown={(e) => {
                e.stopPropagation();
                moveShapeKeypoint(e, elementInfo, index);
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}
