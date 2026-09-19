import {
  Fragment,
  memo,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import type { PPTElement } from '@openmaic/dsl';

import { getLineElementPath } from '@openmaic/renderer';
import { isSelectionModifier, resolveClickSelection } from '../core/selection';
import type { Selection } from '../types';

export interface ElementInteractionTargetProps {
  element: PPTElement;
  isSelected: boolean;
  interactive: boolean;
  movable: boolean;
  sourceElements: PPTElement[];
  selection: Selection;
  viewportLeft: number;
  viewportTop: number;
  canvasScale: number;
  editingTouchAction: CSSProperties['touchAction'];
  onElementPointerDown: (element: PPTElement, event: ReactPointerEvent) => void;
  onElementClick?: (element: PPTElement, event: ReactPointerEvent) => void;
  onElementDoubleClick?: (element: PPTElement, event: ReactMouseEvent) => void;
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
    previous.movable === next.movable &&
    previous.sourceElements === next.sourceElements &&
    previous.selection === next.selection &&
    previous.viewportLeft === next.viewportLeft &&
    previous.viewportTop === next.viewportTop &&
    previous.canvasScale === next.canvasScale &&
    previous.editingTouchAction === next.editingTouchAction &&
    previous.onElementPointerDown === next.onElementPointerDown &&
    previous.onElementClick === next.onElementClick &&
    previous.onElementDoubleClick === next.onElementDoubleClick &&
    previous.onSelectionChange === next.onSelectionChange
  );
}

const BODY_CLICK_THRESHOLD_PX = 2;
const MOVE_BORDER_WIDTH_PX = 10;
const EDITING_MOVE_BORDER_OUTSET_PX = 8;

function isCoveredByEditingElement(
  element: PPTElement,
  sourceElements: PPTElement[],
  editingId: string | undefined,
): boolean {
  if (!editingId || element.id === editingId || element.type === 'line') return false;

  const editingIndex = sourceElements.findIndex((candidate) => candidate.id === editingId);
  const elementIndex = sourceElements.findIndex((candidate) => candidate.id === element.id);
  const editingElement = sourceElements[editingIndex];
  if (
    editingIndex < 0 ||
    elementIndex < 0 ||
    elementIndex > editingIndex ||
    (editingElement?.type !== 'text' &&
      editingElement?.type !== 'shape' &&
      editingElement?.type !== 'table')
  ) {
    return false;
  }

  return (
    element.left < editingElement.left + editingElement.width &&
    element.left + element.width > editingElement.left &&
    element.top < editingElement.top + editingElement.height &&
    element.top + element.height > editingElement.top
  );
}

function ElementInteractionTarget({
  element,
  isSelected,
  interactive,
  movable,
  sourceElements,
  selection,
  viewportLeft,
  viewportTop,
  canvasScale,
  editingTouchAction,
  onElementPointerDown,
  onElementClick,
  onElementDoubleClick,
  onSelectionChange,
}: ElementInteractionTargetProps) {
  const bodyPressRef = useRef<{
    pointerId: number;
    clientX: number;
    clientY: number;
    modifier: boolean;
  } | null>(null);
  const isEditingElement = selection.editingId === element.id;
  const isCoveredUnderlay = isCoveredByEditingElement(element, sourceElements, selection.editingId);

  const selectElement = (event: ReactPointerEvent) => {
    event.stopPropagation();
    if (event.button !== 0 || element.lock) return;
    const modifier = isSelectionModifier(event);
    const { next } = resolveClickSelection({
      element,
      elements: sourceElements,
      selection,
      modifier,
    });
    if (next) onSelectionChange?.(next);
    bodyPressRef.current = {
      pointerId: event.pointerId,
      clientX: event.clientX,
      clientY: event.clientY,
      modifier,
    };
    try {
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture is best effort in jsdom and older browsers.
    }
  };

  const finishBodyPress = (event: ReactPointerEvent) => {
    const press = bodyPressRef.current;
    bodyPressRef.current = null;
    if (!press || press.pointerId !== event.pointerId || press.modifier) return;
    const moved = Math.hypot(event.clientX - press.clientX, event.clientY - press.clientY);
    if (moved <= BODY_CLICK_THRESHOLD_PX) onElementClick?.(element, event);
  };

  if (isCoveredUnderlay) return null;

  if (element.type === 'line') {
    if (!interactive && !isSelected) return null;

    const path = getLineElementPath(element);
    const spanWidth = Math.abs(element.start[0] - element.end[0]);
    const spanHeight = Math.abs(element.start[1] - element.end[1]);
    const grabScreenPx = Math.max(10, element.width * canvasScale);
    const grabCanvas = canvasScale > 0 ? grabScreenPx / canvasScale : grabScreenPx;

    const moveFromStroke = isSelected && movable && !element.lock;
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
            data-element-id={moveFromStroke ? element.id : undefined}
            data-select-element-id={!moveFromStroke ? element.id : undefined}
            d={path}
            fill="none"
            stroke="transparent"
            strokeWidth={grabCanvas}
            pointerEvents={interactive ? 'stroke' : 'none'}
            onPointerDown={(event) =>
              moveFromStroke ? onElementPointerDown(element, event) : selectElement(event)
            }
            style={{
              cursor: moveFromStroke ? 'move' : 'default',
              touchAction: editingTouchAction,
            }}
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

  const screenWidth = element.width * canvasScale;
  const screenHeight = element.height * canvasScale;
  const showMoveBorder = isSelected && movable;

  return (
    <Fragment>
      {!isEditingElement && (
        <div
          data-select-element-id={element.id}
          data-context-element-id={element.id}
          onPointerDown={selectElement}
          onPointerUp={finishBodyPress}
          onPointerCancel={() => {
            bodyPressRef.current = null;
          }}
          onDoubleClick={(event) => onElementDoubleClick?.(element, event)}
          style={{
            ...frameStyle,
            cursor: element.type === 'text' ? 'text' : 'default',
          }}
        />
      )}
      {showMoveBorder && (
        <div
          data-element-id={element.id}
          data-context-element-id={element.id}
          onPointerDown={(event) => onElementPointerDown(element, event)}
          style={{
            ...frameStyle,
            pointerEvents: 'none',
            overflow: 'visible',
            cursor: 'move',
          }}
        >
          <svg
            width={isEditingElement ? screenWidth + EDITING_MOVE_BORDER_OUTSET_PX * 2 : screenWidth}
            height={
              isEditingElement ? screenHeight + EDITING_MOVE_BORDER_OUTSET_PX * 2 : screenHeight
            }
            overflow="visible"
            style={{
              display: 'block',
              left: isEditingElement ? -EDITING_MOVE_BORDER_OUTSET_PX : undefined,
              overflow: 'visible',
              pointerEvents: 'none',
              position: isEditingElement ? 'absolute' : undefined,
              top: isEditingElement ? -EDITING_MOVE_BORDER_OUTSET_PX : undefined,
            }}
          >
            {isEditingElement ? (
              <>
                <rect
                  data-move-border={element.id}
                  x={0}
                  y={0}
                  width={screenWidth + EDITING_MOVE_BORDER_OUTSET_PX * 2}
                  height={EDITING_MOVE_BORDER_OUTSET_PX}
                  fill="transparent"
                  pointerEvents="all"
                  style={{ cursor: 'move', touchAction: editingTouchAction }}
                />
                <rect
                  data-move-border={element.id}
                  x={0}
                  y={screenHeight + EDITING_MOVE_BORDER_OUTSET_PX}
                  width={screenWidth + EDITING_MOVE_BORDER_OUTSET_PX * 2}
                  height={EDITING_MOVE_BORDER_OUTSET_PX}
                  fill="transparent"
                  pointerEvents="all"
                  style={{ cursor: 'move', touchAction: editingTouchAction }}
                />
                <rect
                  data-move-border={element.id}
                  x={0}
                  y={EDITING_MOVE_BORDER_OUTSET_PX}
                  width={EDITING_MOVE_BORDER_OUTSET_PX}
                  height={screenHeight}
                  fill="transparent"
                  pointerEvents="all"
                  style={{ cursor: 'move', touchAction: editingTouchAction }}
                />
                <rect
                  data-move-border={element.id}
                  x={screenWidth + EDITING_MOVE_BORDER_OUTSET_PX}
                  y={EDITING_MOVE_BORDER_OUTSET_PX}
                  width={EDITING_MOVE_BORDER_OUTSET_PX}
                  height={screenHeight}
                  fill="transparent"
                  pointerEvents="all"
                  style={{ cursor: 'move', touchAction: editingTouchAction }}
                />
              </>
            ) : (
              <rect
                data-move-border={element.id}
                x={0}
                y={0}
                width={screenWidth}
                height={screenHeight}
                fill="none"
                stroke="transparent"
                strokeWidth={MOVE_BORDER_WIDTH_PX}
                pointerEvents="stroke"
                style={{ cursor: 'move', touchAction: editingTouchAction }}
              />
            )}
          </svg>
        </div>
      )}
    </Fragment>
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
  movable: boolean;
  viewportLeft: number;
  viewportTop: number;
  canvasScale: number;
  editingTouchAction: CSSProperties['touchAction'];
  onElementPointerDown: (element: PPTElement, event: ReactPointerEvent) => void;
  onElementClick?: (element: PPTElement, event: ReactPointerEvent) => void;
  onElementDoubleClick?: (element: PPTElement, event: ReactMouseEvent) => void;
  onSelectionChange?: (next: Selection) => void;
}

export function ElementInteractionLayer({
  elements,
  sourceElements,
  selection,
  interactive,
  movable,
  viewportLeft,
  viewportTop,
  canvasScale,
  editingTouchAction,
  onElementPointerDown,
  onElementClick,
  onElementDoubleClick,
  onSelectionChange,
}: ElementInteractionLayerProps) {
  return elements.map((element) => (
    <MemoizedElementInteractionTarget
      key={element.id}
      element={element}
      isSelected={selection.elementIds.includes(element.id)}
      interactive={interactive}
      movable={movable}
      sourceElements={sourceElements}
      selection={selection}
      viewportLeft={viewportLeft}
      viewportTop={viewportTop}
      canvasScale={canvasScale}
      editingTouchAction={editingTouchAction}
      onElementPointerDown={onElementPointerDown}
      onElementClick={onElementClick}
      onElementDoubleClick={onElementDoubleClick}
      onSelectionChange={onSelectionChange}
    />
  ));
}
