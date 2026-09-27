import { useCallback } from 'react';
import { useCanvasStore, useKeyboardStore } from '@/lib/store';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import type { PPTElement } from '@openmaic/dsl';
import type { AlignmentLineProps } from '@/lib/types/edit';
import {
  getElementRange,
  getElementListRange,
  uniqAlignLines,
  type AlignLine,
} from '@/lib/utils/element';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

/**
 * Drag element hook
 *
 * @param elementListRef - Element list ref (holds latest value)
 * @param setElementList - Element list setter (triggers re-render)
 * @param setAlignmentLines - Alignment lines setter
 */
export function useDragElement(
  elementListRef: React.RefObject<PPTElement[]>,
  setElementList: React.Dispatch<React.SetStateAction<PPTElement[]>>,
  setAlignmentLines: React.Dispatch<React.SetStateAction<AlignmentLineProps[]>>,
) {
  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const activeGroupElementId = useCanvasStore.use.activeGroupElementId();
  const canvasScale = useCanvasStore.use.canvasScale();
  const shiftKeyState = useKeyboardStore((state) => state.shiftKeyState);

  const viewportRatio = useCanvasStore.use.viewportRatio();
  const viewportSize = useCanvasStore.use.viewportSize();
  const updateSlide = useCanvasOperations().updateSlide;

  const { addHistorySnapshot } = useHistorySnapshot();

  const dragElement = useCallback(
    (e: React.MouseEvent | React.TouchEvent, element: PPTElement) => {
      const native = e.nativeEvent;
      const isTouchEvent = native instanceof TouchEvent;
      if (isTouchEvent && !native.changedTouches?.length) return;

      if (!activeElementIdList.includes(element.id)) return;

      let isMouseDown = true;
      const edgeWidth = viewportSize;
      const edgeHeight = viewportSize * viewportRatio;

      const sorptionRange = 5;

      // Save original element list for computing multi-select offsets
      const originElementList: PPTElement[] = JSON.parse(JSON.stringify(elementListRef.current));
      const originActiveElementList = originElementList.filter((el) =>
        activeElementIdList.includes(el.id),
      );

      const elOriginLeft = element.left;
      const elOriginTop = element.top;

      const startPageX = isTouchEvent ? native.changedTouches[0].pageX : native.pageX;
      const startPageY = isTouchEvent ? native.changedTouches[0].pageY : native.pageY;

      let isMisoperation: boolean | null = null;

      const isActiveGroupElement = element.id === activeGroupElementId;
      const originRange =
        activeElementIdList.length === 1 || isActiveGroupElement
          ? getElementRange(element)
          : getElementListRange(originActiveElementList);

      // Collect alignment snap lines
      // Includes snap positions of other elements on canvas (excluding the target): top/bottom/left/right edges, horizontal/vertical centers
      // Lines and rotated elements need their bounding ranges recalculated
      let horizontalLines: AlignLine[] = [];
      let verticalLines: AlignLine[] = [];

      for (const el of elementListRef.current) {
        if (el.type === 'line') continue;
        if (isActiveGroupElement && el.id === element.id) continue;
        if (!isActiveGroupElement && activeElementIdList.includes(el.id)) continue;

        const { minX: left, minY: top, maxX: right, maxY: bottom } = getElementRange(el);
        const width = right - left;
        const height = bottom - top;

        const centerX = top + height / 2;
        const centerY = left + width / 2;

        const topLine: AlignLine = { value: top, range: [left, right] };
        const bottomLine: AlignLine = { value: bottom, range: [left, right] };
        const horizontalCenterLine: AlignLine = {
          value: centerX,
          range: [left, right],
        };
        const leftLine: AlignLine = { value: left, range: [top, bottom] };
        const rightLine: AlignLine = { value: right, range: [top, bottom] };
        const verticalCenterLine: AlignLine = {
          value: centerY,
          range: [top, bottom],
        };

        horizontalLines.push(topLine, bottomLine, horizontalCenterLine);
        verticalLines.push(leftLine, rightLine, verticalCenterLine);
      }

      // Canvas viewport edges: four boundaries, horizontal center, vertical center
      const edgeTopLine: AlignLine = { value: 0, range: [0, edgeWidth] };
      const edgeBottomLine: AlignLine = {
        value: edgeHeight,
        range: [0, edgeWidth],
      };
      const edgeHorizontalCenterLine: AlignLine = {
        value: edgeHeight / 2,
        range: [0, edgeWidth],
      };
      const edgeLeftLine: AlignLine = { value: 0, range: [0, edgeHeight] };
      const edgeRightLine: AlignLine = {
        value: edgeWidth,
        range: [0, edgeHeight],
      };
      const edgeVerticalCenterLine: AlignLine = {
        value: edgeWidth / 2,
        range: [0, edgeHeight],
      };

      horizontalLines.push(edgeTopLine, edgeBottomLine, edgeHorizontalCenterLine);
      verticalLines.push(edgeLeftLine, edgeRightLine, edgeVerticalCenterLine);

      // Deduplicate alignment snap lines
      horizontalLines = uniqAlignLines(horizontalLines);
      verticalLines = uniqAlignLines(verticalLines);

      const handleMouseMove = (e: MouseEvent | TouchEvent) => {
        const currentPageX = e instanceof MouseEvent ? e.pageX : e.changedTouches[0].pageX;
        const currentPageY = e instanceof MouseEvent ? e.pageY : e.changedTouches[0].pageY;

        // If mouse movement is too small, consider it a misoperation:
        // null = first move, need to check; true = still in misoperation range; false = moved beyond range
        if (isMisoperation !== false) {
          isMisoperation =
            Math.abs(startPageX - currentPageX) < sorptionRange &&
            Math.abs(startPageY - currentPageY) < sorptionRange;
        }
        if (!isMouseDown || isMisoperation) return;

        let moveX = (currentPageX - startPageX) / canvasScale;
        let moveY = (currentPageY - startPageY) / canvasScale;

        // Lock to horizontal or vertical direction when Shift is held
        if (shiftKeyState) {
          if (Math.abs(moveX) > Math.abs(moveY)) moveY = 0;
          if (Math.abs(moveX) < Math.abs(moveY)) moveX = 0;
        }

        // Base target position
        let targetLeft = elOriginLeft + moveX;
        let targetTop = elOriginTop + moveY;

        // Translate the original single-element or selection bounds with the gesture.
        const targetMinX = originRange.minX + moveX;
        const targetMaxX = originRange.maxX + moveX;
        const targetMinY = originRange.minY + moveY;
        const targetMaxY = originRange.maxY + moveY;

        const targetCenterX = targetMinX + (targetMaxX - targetMinX) / 2;
        const targetCenterY = targetMinY + (targetMaxY - targetMinY) / 2;

        // Compare alignment snap lines with target position; auto-correct when difference is within threshold
        // Horizontal and vertical directions are calculated separately
        const _alignmentLines: AlignmentLineProps[] = [];
        let isVerticalAdsorbed = false;
        let isHorizontalAdsorbed = false;

        for (let i = 0; i < horizontalLines.length; i++) {
          const { value, range } = horizontalLines[i];
          const min = Math.min(...range, targetMinX, targetMaxX);
          const max = Math.max(...range, targetMinX, targetMaxX);

          if (Math.abs(targetMinY - value) < sorptionRange && !isHorizontalAdsorbed) {
            targetTop = targetTop - (targetMinY - value);
            isHorizontalAdsorbed = true;
            _alignmentLines.push({
              type: 'horizontal',
              axis: { x: min - 50, y: value },
              length: max - min + 100,
            });
          }
          if (Math.abs(targetMaxY - value) < sorptionRange && !isHorizontalAdsorbed) {
            targetTop = targetTop - (targetMaxY - value);
            isHorizontalAdsorbed = true;
            _alignmentLines.push({
              type: 'horizontal',
              axis: { x: min - 50, y: value },
              length: max - min + 100,
            });
          }
          if (Math.abs(targetCenterY - value) < sorptionRange && !isHorizontalAdsorbed) {
            targetTop = targetTop - (targetCenterY - value);
            isHorizontalAdsorbed = true;
            _alignmentLines.push({
              type: 'horizontal',
              axis: { x: min - 50, y: value },
              length: max - min + 100,
            });
          }
        }

        for (let i = 0; i < verticalLines.length; i++) {
          const { value, range } = verticalLines[i];
          const min = Math.min(...range, targetMinY, targetMaxY);
          const max = Math.max(...range, targetMinY, targetMaxY);

          if (Math.abs(targetMinX - value) < sorptionRange && !isVerticalAdsorbed) {
            targetLeft = targetLeft - (targetMinX - value);
            isVerticalAdsorbed = true;
            _alignmentLines.push({
              type: 'vertical',
              axis: { x: value, y: min - 50 },
              length: max - min + 100,
            });
          }
          if (Math.abs(targetMaxX - value) < sorptionRange && !isVerticalAdsorbed) {
            targetLeft = targetLeft - (targetMaxX - value);
            isVerticalAdsorbed = true;
            _alignmentLines.push({
              type: 'vertical',
              axis: { x: value, y: min - 50 },
              length: max - min + 100,
            });
          }
          if (Math.abs(targetCenterX - value) < sorptionRange && !isVerticalAdsorbed) {
            targetLeft = targetLeft - (targetCenterX - value);
            isVerticalAdsorbed = true;
            _alignmentLines.push({
              type: 'vertical',
              axis: { x: value, y: min - 50 },
              length: max - min + 100,
            });
          }
        }

        setAlignmentLines(_alignmentLines);
        let newElements: PPTElement[];

        // In single-select mode or when the active group element is being operated, only update that element's position
        if (activeElementIdList.length === 1 || isActiveGroupElement) {
          newElements = elementListRef.current.map((el) => {
            if (el.id === element.id) {
              return { ...el, left: targetLeft, top: targetTop };
            }
            return el;
          });
        }
        // In multi-select mode, also update positions of other selected elements
        // Their positions are calculated from the movement offset of the handle element
        else {
          const handleElement = elementListRef.current.find((el) => el.id === element.id);
          if (!handleElement) return;

          newElements = elementListRef.current.map((el) => {
            if (activeElementIdList.includes(el.id)) {
              if (el.id === element.id) {
                return { ...el, left: targetLeft, top: targetTop };
              }
              return {
                ...el,
                left: el.left + (targetLeft - handleElement.left),
                top: el.top + (targetTop - handleElement.top),
              };
            }
            return el;
          });
        }

        // Update both ref (latest value) and state (trigger re-render)
        elementListRef.current = newElements;
        setElementList(newElements);
      };

      const handleMouseUp = (e: MouseEvent | TouchEvent) => {
        isMouseDown = false;

        document.ontouchmove = null;
        document.ontouchend = null;
        document.onmousemove = null;
        document.onmouseup = null;

        setAlignmentLines([]);

        const currentPageX = e instanceof MouseEvent ? e.pageX : e.changedTouches[0].pageX;
        const currentPageY = e instanceof MouseEvent ? e.pageY : e.changedTouches[0].pageY;

        if (startPageX === currentPageX && startPageY === currentPageY) return;

        updateSlide({ elements: elementListRef.current });
        addHistorySnapshot();
      };

      if (isTouchEvent) {
        document.ontouchmove = handleMouseMove;
        document.ontouchend = handleMouseUp;
      } else {
        document.onmousemove = handleMouseMove;
        document.onmouseup = handleMouseUp;
      }
    },
    [
      activeElementIdList,
      activeGroupElementId,
      shiftKeyState,
      canvasScale,
      elementListRef,
      setElementList,
      setAlignmentLines,
      updateSlide,
      addHistorySnapshot,
      viewportRatio,
      viewportSize,
    ],
  );

  return {
    dragElement,
  };
}
