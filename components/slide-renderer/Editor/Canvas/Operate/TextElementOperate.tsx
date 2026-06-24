import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTTextElement } from '@openmaic/dsl';
import type { OperateResizeHandlers } from '@/lib/types/edit';
import { useCommonOperate } from '../hooks/useCommonOperate';
import { RotateHandler } from './RotateHandler';
import { ResizeHandler } from './ResizeHandler';
import { BorderLine } from './BorderLine';

interface TextElementOperateProps {
  readonly elementInfo: PPTTextElement;
  readonly handlerVisible: boolean;
  readonly rotateElement: (e: React.MouseEvent, element: PPTTextElement) => void;
  readonly scaleElement: (
    e: React.MouseEvent,
    element: PPTTextElement,
    command: OperateResizeHandlers,
  ) => void;
}

export function TextElementOperate({
  elementInfo,
  handlerVisible,
  rotateElement,
  scaleElement,
}: TextElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();
  const editingElementId = useCanvasStore.use.editingElementId();
  const isEditing = editingElementId === elementInfo.id;

  const scaleWidth = useMemo(
    () => elementInfo.width * canvasScale,
    [elementInfo.width, canvasScale],
  );
  const scaleHeight = useMemo(
    () => elementInfo.height * canvasScale,
    [elementInfo.height, canvasScale],
  );

  const { textElementResizeHandlers, verticalTextElementResizeHandlers, borderLines } =
    useCommonOperate(scaleWidth, scaleHeight);
  const resizeHandlers = useMemo(
    () => (elementInfo.vertical ? verticalTextElementResizeHandlers : textElementResizeHandlers),
    [elementInfo.vertical, textElementResizeHandlers, verticalTextElementResizeHandlers],
  );

  return (
    <div className="text-element-operate">
      {isEditing ? (
        // One clean editing frame. While a single text element is being
        // edited the surface sets `editingElementId`, so the renderer drops
        // the dashed select frame here — eliminating the redundant box
        // stacked on the focused editor. Resize/rotate handles are kept.
        //
        // pointer-events-none: this is a purely visual full-size overlay —
        // without it, it would mask the text element's own move cursor,
        // text cursor, click-to-caret and drag-to-move. The dashed
        // BorderLines it replaces are thin edge lines, so they never did.
        <div
          className="operate-edit-frame pointer-events-none absolute top-0 left-0 border border-primary"
          style={{ width: scaleWidth + 'px', height: scaleHeight + 'px' }}
        />
      ) : (
        borderLines.map((line) => (
          <BorderLine
            key={line.type}
            type={line.type}
            style={line.style}
            className="operate-border-line"
          />
        ))
      )}
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
