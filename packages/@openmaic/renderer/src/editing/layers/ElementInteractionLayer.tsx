import { memo, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import type { PPTElement } from '@openmaic/dsl';

import { getLineElementPath } from '../../utils/element';
import { isSelectionModifier, resolveClickSelection } from '../core/selection';
import type { Selection } from '../types';

export interface ElementInteractionTargetProps {
  element: PPTElement;
  isSelected: boolean;
  interactive: boolean;
  sourceElements: PPTElement[];
  selection: Selection;
  viewportLeft: number;
  viewportTop: number;
  canvasScale: number;
  editingTouchAction: CSSProperties['touchAction'];
  onElementPointerDown: (element: PPTElement, event: ReactPointerEvent) => void;
  onSelectionChange?: (next: Selection) => void;
}

export function areElementInteractionTargetPropsEqual(
  previous: ElementInteractionTargetProps,
  next: ElementInteractionTargetProps,
): boolean {
  return (
    previous.element === next.element &&
    previous.isSelected === next.isSelected &&
    previous.interactive === next.interactive &&
    previous.sourceElements === next.sourceElements &&
    previous.selection === next.selection &&
    previous.viewportLeft === next.viewportLeft &&
    previous.viewportTop === next.viewportTop &&
    previous.canvasScale === next.canvasScale &&
    previous.editingTouchAction === next.editingTouchAction &&
    previous.onElementPointerDown === next.onElementPointerDown &&
    previous.onSelectionChange === next.onSelectionChange
  );
}

function ElementInteractionTarget({
  element,
  isSelected,
  interactive,
  sourceElements,
  selection,
  viewportLeft,
  viewportTop,
  canvasScale,
  editingTouchAction,
  onElementPointerDown,
  onSelectionChange,
}: ElementInteractionTargetProps) {
  if (element.type === 'line') {
    if (!interactive && !isSelected) return null;

    const path = getLineElementPath(element);
    const spanWidth = Math.abs(element.start[0] - element.end[0]);
    const spanHeight = Math.abs(element.start[1] - element.end[1]);
    const grabScreenPx = Math.max(10, element.width * canvasScale);
    const grabCanvas = canvasScale > 0 ? grabScreenPx / canvasScale : grabScreenPx;

    return (
      <div
        style={{
          position: 'absolute',
          left: `${viewportLeft + element.left * canvasScale}px`,
          top: `${viewportTop + element.top * canvasScale}px`,
          width: 0,
          height: 0,
          pointerEvents: 'none',
          overflow: 'visible',
        }}
      >
        <svg
          overflow="visible"
          width={Math.max(24, spanWidth)}
          height={Math.max(24, spanHeight)}
          style={{
            overflow: 'visible',
            transform: `scale(${canvasScale})`,
            transformOrigin: '0 0',
            pointerEvents: 'none',
          }}
        >
          <path
            data-hit-kind="line"
            data-context-element-id={element.id}
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={grabCanvas}
            pointerEvents={interactive ? 'stroke' : 'none'}
            onPointerDown={(event) => {
              event.stopPropagation();
              if (element.lock) return;
              const { next } = resolveClickSelection({
                element,
                elements: sourceElements,
                selection,
                modifier: isSelectionModifier(event),
              });
              if (next) onSelectionChange?.(next);
            }}
            style={{ cursor: 'default', touchAction: editingTouchAction }}
          />
          {isSelected && (
            <path
              data-hit-kind="line-highlight"
              d={path}
              fill="none"
              stroke="#3b82f6"
              strokeOpacity={0.7}
              strokeWidth={Math.max(2, element.width)}
              pointerEvents="none"
              style={{ pointerEvents: 'none' }}
            />
          )}
        </svg>
      </div>
    );
  }

  if (!interactive) return null;

  const frameStyle = {
    position: 'absolute',
    left: `${viewportLeft + element.left * canvasScale}px`,
    top: `${viewportTop + element.top * canvasScale}px`,
    width: `${element.width * canvasScale}px`,
    height: `${element.height * canvasScale}px`,
    transform: `rotate(${element.rotate}deg)`,
    transformOrigin: 'center',
    pointerEvents: 'auto',
    touchAction: editingTouchAction,
  } satisfies CSSProperties;

  if (element.lock) {
    return (
      <div
        data-hit-kind="blocker"
        data-context-element-id={element.id}
        onPointerDown={(event) => event.stopPropagation()}
        style={{ ...frameStyle, cursor: 'default' }}
      />
    );
  }

  return (
    <div
      data-element-id={element.id}
      onPointerDown={(event) => onElementPointerDown(element, event)}
      style={{ ...frameStyle, cursor: 'move' }}
    />
  );
}

const MemoizedElementInteractionTarget = memo(
  ElementInteractionTarget,
  areElementInteractionTargetPropsEqual,
);

interface ElementInteractionLayerProps {
  elements: PPTElement[];
  sourceElements: PPTElement[];
  selection: Selection;
  interactive: boolean;
  viewportLeft: number;
  viewportTop: number;
  canvasScale: number;
  editingTouchAction: CSSProperties['touchAction'];
  onElementPointerDown: (element: PPTElement, event: ReactPointerEvent) => void;
  onSelectionChange?: (next: Selection) => void;
}

export function ElementInteractionLayer({
  elements,
  sourceElements,
  selection,
  interactive,
  viewportLeft,
  viewportTop,
  canvasScale,
  editingTouchAction,
  onElementPointerDown,
  onSelectionChange,
}: ElementInteractionLayerProps) {
  return elements.map((element) => (
    <MemoizedElementInteractionTarget
      key={element.id}
      element={element}
      isSelected={selection.elementIds.includes(element.id)}
      interactive={interactive}
      sourceElements={sourceElements}
      selection={selection}
      viewportLeft={viewportLeft}
      viewportTop={viewportTop}
      canvasScale={canvasScale}
      editingTouchAction={editingTouchAction}
      onElementPointerDown={onElementPointerDown}
      onSelectionChange={onSelectionChange}
    />
  ));
}
