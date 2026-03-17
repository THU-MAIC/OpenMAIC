import { useMemo } from 'react';
import { useCanvasStore } from '@/lib/store';
import type { PPTLineElement } from '@/lib/types/slides';
import { OperateLineHandlers } from '@/lib/types/edit';
import { ResizeHandler } from './ResizeHandler';

interface LineElementOperateProps {
  readonly elementInfo: PPTLineElement;
  readonly handlerVisible: boolean;
  readonly dragLineElement: (
    e: React.MouseEvent,
    element: PPTLineElement,
    command: OperateLineHandlers,
  ) => void;
}

export function LineElementOperate({
  elementInfo,
  handlerVisible,
  dragLineElement,
}: LineElementOperateProps) {
  const canvasScale = useCanvasStore.use.canvasScale();

  const svgWidth = useMemo(
    () => Math.max(elementInfo.start[0], elementInfo.end[0]),
    [elementInfo.start, elementInfo.end],
  );
  const svgHeight = useMemo(
    () => Math.max(elementInfo.start[1], elementInfo.end[1]),
    [elementInfo.start, elementInfo.end],
  );

  const resizeHandlers = useMemo(() => {
    const handlers = [
      {
        handler: OperateLineHandlers.START,
        style: {
          left: elementInfo.start[0] * canvasScale + 'px',
          top: elementInfo.start[1] * canvasScale + 'px',
        },
      },
      {
        handler: OperateLineHandlers.END,
        style: {
          left: elementInfo.end[0] * canvasScale + 'px',
          top: elementInfo.end[1] * canvasScale + 'px',
        },
      },
    ];

    if (elementInfo.curve || elementInfo.broken || elementInfo.broken2) {
      const ctrlHandler = (elementInfo.curve || elementInfo.broken || elementInfo.broken2) as [
        number,
        number,
      ];

      handlers.push({
        handler: OperateLineHandlers.C,
        style: {
          left: ctrlHandler[0] * canvasScale + 'px',
          top: ctrlHandler[1] * canvasScale + 'px',
        },
      });
    } else if (elementInfo.cubic) {
      const [ctrlHandler1, ctrlHandler2] = elementInfo.cubic;
      handlers.push({
        handler: OperateLineHandlers.C1,
        style: {
          left: ctrlHandler1[0] * canvasScale + 'px',
          top: ctrlHandler1[1] * canvasScale + 'px',
        },
      });
      handlers.push({
        handler: OperateLineHandlers.C2,
        style: {
          left: ctrlHandler2[0] * canvasScale + 'px',
          top: ctrlHandler2[1] * canvasScale + 'px',
        },
      });
    }

    return handlers;
  }, [elementInfo, canvasScale]);

  return (
    <div className="line-element-operate">
      {handlerVisible && (
        <>
          {resizeHandlers.map((point) => (
            <ResizeHandler
              key={point.handler}
              style={point.style}
              className="operate-resize-handler"
              onMouseDown={(e) => {
                e.stopPropagation();
                dragLineElement(e, elementInfo, point.handler);
              }}
            />
          ))}

          <svg
            width={svgWidth || 1}
            height={svgHeight || 1}
            stroke={elementInfo.color}
            className="absolute left-0 top-0 pointer-events-none origin-top-left"
            style={{ transform: `scale(${canvasScale})`, overflow: 'visible' }}
          >
            {elementInfo.curve && (
              <g>
                <line
                  className="anchor-line stroke-1 stroke-dasharray-[5_5] opacity-50"
                  x1={elementInfo.start[0]}
                  y1={elementInfo.start[1]}
                  x2={elementInfo.curve[0]}
                  y2={elementInfo.curve[1]}
                />
                <line
                  className="anchor-line stroke-1 stroke-dasharray-[5_5] opacity-50"
                  x1={elementInfo.end[0]}
                  y1={elementInfo.end[1]}
                  x2={elementInfo.curve[0]}
                  y2={elementInfo.curve[1]}
                />
              </g>
            )}
            {elementInfo.cubic?.map((item, index) => (
              <g key={index}>
                {index === 0 && (
                  <line
                    className="anchor-line stroke-1 stroke-dasharray-[5_5] opacity-50"
                    x1={elementInfo.start[0]}
                    y1={elementInfo.start[1]}
                    x2={item[0]}
                    y2={item[1]}
                  />
                )}
                {index === 1 && (
                  <line
                    className="anchor-line stroke-1 stroke-dasharray-[5_5] opacity-50"
                    x1={elementInfo.end[0]}
                    y1={elementInfo.end[1]}
                    x2={item[0]}
                    y2={item[1]}
                  />
                )}
              </g>
            ))}
          </svg>
        </>
      )}
    </div>
  );
}
