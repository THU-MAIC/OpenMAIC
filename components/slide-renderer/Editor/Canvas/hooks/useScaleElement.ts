import { useCallback } from 'react';
import { useCanvasStore } from '@/lib/store';
import { useKeyboardStore } from '@/lib/store/keyboard';
import type {
  PPTElement,
  PPTLineElement,
  PPTImageElement,
  PPTShapeElement,
} from '@/lib/types/slides';
import {
  OperateResizeHandlers,
  type AlignmentLineProps,
  type MultiSelectRange,
} from '@/lib/types/edit';
import { MIN_SIZE } from '@/configs/element';
import { SHAPE_PATH_FORMULAS } from '@/configs/shapes';
import { type AlignLine, uniqAlignLines } from '@/lib/utils/element';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

interface RotateElementData {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * Calculate the positions of the eight scale points of a rotated element
 * @param element Original position and size of the element
 * @param angle Rotation angle
 */
const getRotateElementPoints = (element: RotateElementData, angle: number) => {
  const { left, top, width, height } = element;

  const radius = Math.sqrt(Math.pow(width, 2) + Math.pow(height, 2)) / 2;
  const auxiliaryAngle = (Math.atan(height / width) * 180) / Math.PI;

  const tlbraRadian = ((180 - angle - auxiliaryAngle) * Math.PI) / 180;
  const trblaRadian = ((auxiliaryAngle - angle) * Math.PI) / 180;
  const taRadian = ((90 - angle) * Math.PI) / 180;
  const raRadian = (angle * Math.PI) / 180;

  const halfWidth = width / 2;
  const halfHeight = height / 2;

  const middleLeft = left + halfWidth;
  const middleTop = top + halfHeight;

  const leftTopPoint = {
    left: middleLeft + radius * Math.cos(tlbraRadian),
    top: middleTop - radius * Math.sin(tlbraRadian),
  };
  const topPoint = {
    left: middleLeft + halfHeight * Math.cos(taRadian),
    top: middleTop - halfHeight * Math.sin(taRadian),
  };
  const rightTopPoint = {
    left: middleLeft + radius * Math.cos(trblaRadian),
    top: middleTop - radius * Math.sin(trblaRadian),
  };
  const rightPoint = {
    left: middleLeft + halfWidth * Math.cos(raRadian),
    top: middleTop + halfWidth * Math.sin(raRadian),
  };
  const rightBottomPoint = {
    left: middleLeft - radius * Math.cos(tlbraRadian),
    top: middleTop + radius * Math.sin(tlbraRadian),
  };
  const bottomPoint = {
    left: middleLeft - halfHeight * Math.sin(raRadian),
    top: middleTop + halfHeight * Math.cos(raRadian),
  };
  const leftBottomPoint = {
    left: middleLeft - radius * Math.cos(trblaRadian),
    top: middleTop + radius * Math.sin(trblaRadian),
  };
  const leftPoint = {
    left: middleLeft - halfWidth * Math.cos(raRadian),
    top: middleTop - halfWidth * Math.sin(raRadian),
  };

  return {
    leftTopPoint,
    topPoint,
    rightTopPoint,
    rightPoint,
    rightBottomPoint,
    bottomPoint,
    leftBottomPoint,
    leftPoint,
  };
};

/**
 * Get the opposite point of a given scale point, e.g. [top] corresponds to [bottom], [left-top] corresponds to [right-bottom]
 * @param direction The current scale point being operated
 * @param points Positions of the eight scale points of the rotated element
 */
const getOppositePoint = (
  direction: OperateResizeHandlers,
  points: ReturnType<typeof getRotateElementPoints>,
): { left: number; top: number } => {
  const oppositeMap = {
    [OperateResizeHandlers.RIGHT_BOTTOM]: points.leftTopPoint,
    [OperateResizeHandlers.LEFT_BOTTOM]: points.rightTopPoint,
    [OperateResizeHandlers.LEFT_TOP]: points.rightBottomPoint,
    [OperateResizeHandlers.RIGHT_TOP]: points.leftBottomPoint,
    [OperateResizeHandlers.TOP]: points.bottomPoint,
    [OperateResizeHandlers.BOTTOM]: points.topPoint,
    [OperateResizeHandlers.LEFT]: points.rightPoint,
    [OperateResizeHandlers.RIGHT]: points.leftPoint,
  };
  return oppositeMap[direction];
};

/**
 * Scale element Hook
 *
 * @param elementListRef - Element list ref (stores the latest value)
 * @param setElementList - Element list setter (used to trigger re-render)
 * @param setAlignmentLines - Alignment lines setter
 */
export function useScaleElement(
  elementListRef: React.RefObject<PPTElement[]>,
  setElementList: React.Dispatch<React.SetStateAction<PPTElement[]>>,
  setAlignmentLines: React.Dispatch<React.SetStateAction<AlignmentLineProps[]>>,
) {
  const setScalingState = useCanvasStore.use.setScalingState();
  const activeElementIdList = useCanvasStore.use.activeElementIdList();
  const activeGroupElementId = useCanvasStore.use.activeGroupElementId();
  const canvasScale = useCanvasStore.use.canvasScale();

  const viewportRatio = useCanvasStore.use.viewportRatio();
  const viewportSize = useCanvasStore.use.viewportSize();

  const updateSlide = useCanvasOperations().updateSlide;

  const ctrlOrShiftKeyActive = useKeyboardStore((state) => state.ctrlOrShiftKeyActive());

  const { addHistorySnapshot } = useHistorySnapshot();

  // Scale element
  const scaleElement = useCallback(
    (
      e: React.MouseEvent | React.TouchEvent,
      element: Exclude<PPTElement, PPTLineElement>,
      command: OperateResizeHandlers,
    ) => {
      const native = e.nativeEvent;
      const isTouchEvent = native instanceof TouchEvent;
      if (isTouchEvent && !native.changedTouches?.length) return;

      let isMouseDown = true;
      setScalingState(true);

      const elOriginLeft = element.left;
      const elOriginTop = element.top;
      const elOriginWidth = element.width;
      const elOriginHeight = element.height;

      const originTableCellMinHeight = element.type === 'table' ? element.cellMinHeight : 0;

      const elRotate = 'rotate' in element && element.rotate ? element.rotate : 0;
      const rotateRadian = (Math.PI * elRotate) / 180;

      const fixedRatio = ctrlOrShiftKeyActive || ('fixedRatio' in element && element.fixedRatio);
      const aspectRatio = elOriginWidth / elOriginHeight;

      const startPageX = isTouchEvent ? native.changedTouches[0].pageX : native.pageX;
      const startPageY = isTouchEvent ? native.changedTouches[0].pageY : native.pageY;

      // Minimum scale size limit for element
      const minSize = MIN_SIZE[element.type] || 20;
      const getSizeWithinRange = (size: number, type: 'width' | 'height') => {
        if (!fixedRatio) return size < minSize ? minSize : size;

        let minWidth = minSize;
        let minHeight = minSize;
        const ratio = element.width / element.height;
        if (ratio < 1) minHeight = minSize / ratio;
        if (ratio > 1) minWidth = minSize * ratio;

        if (type === 'width') return size < minWidth ? minWidth : size;
        return size < minHeight ? minHeight : size;
      };

      let points: ReturnType<typeof getRotateElementPoints>;
      let baseLeft = 0;
      let baseTop = 0;
      let horizontalLines: AlignLine[] = [];
      let verticalLines: AlignLine[] = [];

      // When scaling a rotated element, introduce a base point concept: the point opposite to the current scale handle
      // For example, when dragging the bottom-right corner, the top-left corner is the base point that stays fixed while other points move to achieve scaling
      if ('rotate' in element && element.rotate) {
        const { left, top, width, height } = element;
        points = getRotateElementPoints({ left, top, width, height }, elRotate);
        const oppositePoint = getOppositePoint(command, points);

        baseLeft = oppositePoint.left;
        baseTop = oppositePoint.top;
      }
      // Non-rotated elements support alignment snapping during scaling; collect alignment snap lines here
      // Includes snappable alignment positions (top, bottom, left, right edges) of all elements on the canvas except the target element
      // Line elements and rotated elements are excluded from alignment snapping
      else {
        const edgeWidth = viewportSize;
        const edgeHeight = viewportSize * viewportRatio;
        const isActiveGroupElement = element.id === activeGroupElementId;

        for (const el of elementListRef.current) {
          if ('rotate' in el && el.rotate) continue;
          if (el.type === 'line') continue;
          if (isActiveGroupElement && el.id === element.id) continue;
          if (!isActiveGroupElement && activeElementIdList.includes(el.id)) continue;

          const left = el.left;
          const top = el.top;
          const width = el.width;
          const height = el.height;
          const right = left + width;
          const bottom = top + height;

          const topLine: AlignLine = { value: top, range: [left, right] };
          const bottomLine: AlignLine = { value: bottom, range: [left, right] };
          const leftLine: AlignLine = { value: left, range: [top, bottom] };
          const rightLine: AlignLine = { value: right, range: [top, bottom] };

          horizontalLines.push(topLine, bottomLine);
          verticalLines.push(leftLine, rightLine);
        }

        // Four edges of the visible canvas area, horizontal center, and vertical center
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

        horizontalLines = uniqAlignLines(horizontalLines);
        verticalLines = uniqAlignLines(verticalLines);
      }

      // Alignment snapping method
      // Compare collected alignment snap lines with the target element's current position/size data; auto-correct when the difference is within threshold
      // Horizontal and vertical directions are calculated separately
      const alignedAdsorption = (currentX: number | null, currentY: number | null) => {
        const sorptionRange = 5;

        const _alignmentLines: AlignmentLineProps[] = [];
        let isVerticalAdsorbed = false;
        let isHorizontalAdsorbed = false;
        const correctionVal = { offsetX: 0, offsetY: 0 };

        if (currentY || currentY === 0) {
          for (let i = 0; i < horizontalLines.length; i++) {
            const { value, range } = horizontalLines[i];
            const min = Math.min(...range, currentX || 0);
            const max = Math.max(...range, currentX || 0);

            if (Math.abs(currentY - value) < sorptionRange && !isHorizontalAdsorbed) {
              correctionVal.offsetY = currentY - value;
              isHorizontalAdsorbed = true;
              _alignmentLines.push({
                type: 'horizontal',
                axis: { x: min - 50, y: value },
                length: max - min + 100,
              });
            }
          }
        }
        if (currentX || currentX === 0) {
          for (let i = 0; i < verticalLines.length; i++) {
            const { value, range } = verticalLines[i];
            const min = Math.min(...range, currentY || 0);
            const max = Math.max(...range, currentY || 0);

            if (Math.abs(currentX - value) < sorptionRange && !isVerticalAdsorbed) {
              correctionVal.offsetX = currentX - value;
              isVerticalAdsorbed = true;
              _alignmentLines.push({
                type: 'vertical',
                axis: { x: value, y: min - 50 },
                length: max - min + 100,
              });
            }
          }
        }
        setAlignmentLines(_alignmentLines);
        return correctionVal;
      };

      const handleMouseMove = (e: MouseEvent | TouchEvent) => {
        if (!isMouseDown) return;

        const currentPageX = e instanceof MouseEvent ? e.pageX : e.changedTouches[0].pageX;
        const currentPageY = e instanceof MouseEvent ? e.pageY : e.changedTouches[0].pageY;

        const x = currentPageX - startPageX;
        const y = currentPageY - startPageY;

        let width = elOriginWidth;
        let height = elOriginHeight;
        let left = elOriginLeft;
        let top = elOriginTop;

        // For rotated elements, recalculate the scaling distance based on the rotation angle (distance moved after mouse down)
        if (elRotate) {
          const revisedX = (Math.cos(rotateRadian) * x + Math.sin(rotateRadian) * y) / canvasScale;
          let revisedY = (Math.cos(rotateRadian) * y - Math.sin(rotateRadian) * x) / canvasScale;

          // Lock aspect ratio (only triggered by four corners, not edges)
          // Use horizontal scaling distance as the basis to calculate vertical scaling distance, maintaining the same ratio
          if (fixedRatio) {
            if (
              command === OperateResizeHandlers.RIGHT_BOTTOM ||
              command === OperateResizeHandlers.LEFT_TOP
            )
              revisedY = revisedX / aspectRatio;
            if (
              command === OperateResizeHandlers.LEFT_BOTTOM ||
              command === OperateResizeHandlers.RIGHT_TOP
            )
              revisedY = -revisedX / aspectRatio;
          }

          // Calculate element size and position after scaling based on the operation point
          // Note:
          // The position calculated here needs correction later, because scaling a rotated element changes the base point position (visually the base point stays fixed, but that's the combined result of rotation + translation)
          // However, the size does not need correction since the scaling distance was already recalculated above
          if (command === OperateResizeHandlers.RIGHT_BOTTOM) {
            width = getSizeWithinRange(elOriginWidth + revisedX, 'width');
            height = getSizeWithinRange(elOriginHeight + revisedY, 'height');
          } else if (command === OperateResizeHandlers.LEFT_BOTTOM) {
            width = getSizeWithinRange(elOriginWidth - revisedX, 'width');
            height = getSizeWithinRange(elOriginHeight + revisedY, 'height');
            left = elOriginLeft - (width - elOriginWidth);
          } else if (command === OperateResizeHandlers.LEFT_TOP) {
            width = getSizeWithinRange(elOriginWidth - revisedX, 'width');
            height = getSizeWithinRange(elOriginHeight - revisedY, 'height');
            left = elOriginLeft - (width - elOriginWidth);
            top = elOriginTop - (height - elOriginHeight);
          } else if (command === OperateResizeHandlers.RIGHT_TOP) {
            width = getSizeWithinRange(elOriginWidth + revisedX, 'width');
            height = getSizeWithinRange(elOriginHeight - revisedY, 'height');
            top = elOriginTop - (height - elOriginHeight);
          } else if (command === OperateResizeHandlers.TOP) {
            height = getSizeWithinRange(elOriginHeight - revisedY, 'height');
            top = elOriginTop - (height - elOriginHeight);
          } else if (command === OperateResizeHandlers.BOTTOM) {
            height = getSizeWithinRange(elOriginHeight + revisedY, 'height');
          } else if (command === OperateResizeHandlers.LEFT) {
            width = getSizeWithinRange(elOriginWidth - revisedX, 'width');
            left = elOriginLeft - (width - elOriginWidth);
          } else if (command === OperateResizeHandlers.RIGHT) {
            width = getSizeWithinRange(elOriginWidth + revisedX, 'width');
          }

          // Get current base point coordinates, compare with initial base point, and correct element position by the difference
          const currentPoints = getRotateElementPoints({ width, height, left, top }, elRotate);
          const currentOppositePoint = getOppositePoint(command, currentPoints);
          const currentBaseLeft = currentOppositePoint.left;
          const currentBaseTop = currentOppositePoint.top;

          const offsetX = currentBaseLeft - baseLeft;
          const offsetY = currentBaseTop - baseTop;

          left = left - offsetX;
          top = top - offsetY;
        }
        // For non-rotated elements, simply calculate the new position and size without complex corrections
        // Additionally handle alignment snapping operations
        // Aspect ratio locking logic is the same as above
        else {
          let moveX = x / canvasScale;
          let moveY = y / canvasScale;

          if (fixedRatio) {
            if (
              command === OperateResizeHandlers.RIGHT_BOTTOM ||
              command === OperateResizeHandlers.LEFT_TOP
            )
              moveY = moveX / aspectRatio;
            if (
              command === OperateResizeHandlers.LEFT_BOTTOM ||
              command === OperateResizeHandlers.RIGHT_TOP
            )
              moveY = -moveX / aspectRatio;
          }

          if (command === OperateResizeHandlers.RIGHT_BOTTOM) {
            const { offsetX, offsetY } = alignedAdsorption(
              elOriginLeft + elOriginWidth + moveX,
              elOriginTop + elOriginHeight + moveY,
            );
            moveX = moveX - offsetX;
            moveY = moveY - offsetY;
            if (fixedRatio) {
              if (offsetY) moveX = moveY * aspectRatio;
              else moveY = moveX / aspectRatio;
            }
            width = getSizeWithinRange(elOriginWidth + moveX, 'width');
            height = getSizeWithinRange(elOriginHeight + moveY, 'height');
          } else if (command === OperateResizeHandlers.LEFT_BOTTOM) {
            const { offsetX, offsetY } = alignedAdsorption(
              elOriginLeft + moveX,
              elOriginTop + elOriginHeight + moveY,
            );
            moveX = moveX - offsetX;
            moveY = moveY - offsetY;
            if (fixedRatio) {
              if (offsetY) moveX = -moveY * aspectRatio;
              else moveY = -moveX / aspectRatio;
            }
            width = getSizeWithinRange(elOriginWidth - moveX, 'width');
            height = getSizeWithinRange(elOriginHeight + moveY, 'height');
            left = elOriginLeft - (width - elOriginWidth);
          } else if (command === OperateResizeHandlers.LEFT_TOP) {
            const { offsetX, offsetY } = alignedAdsorption(
              elOriginLeft + moveX,
              elOriginTop + moveY,
            );
            moveX = moveX - offsetX;
            moveY = moveY - offsetY;
            if (fixedRatio) {
              if (offsetY) moveX = moveY * aspectRatio;
              else moveY = moveX / aspectRatio;
            }
            width = getSizeWithinRange(elOriginWidth - moveX, 'width');
            height = getSizeWithinRange(elOriginHeight - moveY, 'height');
            left = elOriginLeft - (width - elOriginWidth);
            top = elOriginTop - (height - elOriginHeight);
          } else if (command === OperateResizeHandlers.RIGHT_TOP) {
            const { offsetX, offsetY } = alignedAdsorption(
              elOriginLeft + elOriginWidth + moveX,
              elOriginTop + moveY,
            );
            moveX = moveX - offsetX;
            moveY = moveY - offsetY;
            if (fixedRatio) {
              if (offsetY) moveX = -moveY * aspectRatio;
              else moveY = -moveX / aspectRatio;
            }
            width = getSizeWithinRange(elOriginWidth + moveX, 'width');
            height = getSizeWithinRange(elOriginHeight - moveY, 'height');
            top = elOriginTop - (height - elOriginHeight);
          } else if (command === OperateResizeHandlers.LEFT) {
            const { offsetX } = alignedAdsorption(elOriginLeft + moveX, null);
            moveX = moveX - offsetX;
            width = getSizeWithinRange(elOriginWidth - moveX, 'width');
            left = elOriginLeft - (width - elOriginWidth);
          } else if (command === OperateResizeHandlers.RIGHT) {
            const { offsetX } = alignedAdsorption(elOriginLeft + elOriginWidth + moveX, null);
            moveX = moveX - offsetX;
            width = getSizeWithinRange(elOriginWidth + moveX, 'width');
          } else if (command === OperateResizeHandlers.TOP) {
            const { offsetY } = alignedAdsorption(null, elOriginTop + moveY);
            moveY = moveY - offsetY;
            height = getSizeWithinRange(elOriginHeight - moveY, 'height');
            top = elOriginTop - (height - elOriginHeight);
          } else if (command === OperateResizeHandlers.BOTTOM) {
            const { offsetY } = alignedAdsorption(null, elOriginTop + elOriginHeight + moveY);
            moveY = moveY - offsetY;
            height = getSizeWithinRange(elOriginHeight + moveY, 'height');
          }
        }

        // Update local element list during mousemove
        const newElements = elementListRef.current.map((el) => {
          if (element.id !== el.id) return el;
          if (el.type === 'shape' && 'pathFormula' in el && el.pathFormula) {
            const pathFormula = SHAPE_PATH_FORMULAS[el.pathFormula];

            let path = '';
            if ('editable' in pathFormula) path = pathFormula.formula(width, height, el.keypoints!);
            else path = pathFormula.formula(width, height);

            return {
              ...el,
              left,
              top,
              width,
              height,
              viewBox: [width, height] as [number, number],
              path,
            };
          }
          if (el.type === 'table') {
            let cellMinHeight =
              originTableCellMinHeight + (height - elOriginHeight) / el.data.length;
            cellMinHeight = cellMinHeight < 36 ? 36 : cellMinHeight;

            if (cellMinHeight === originTableCellMinHeight) return { ...el, left, width };
            return {
              ...el,
              left,
              top,
              width,
              height,
              cellMinHeight: cellMinHeight < 36 ? 36 : cellMinHeight,
            };
          }
          return { ...el, left, top, width, height };
        });

        // Update both ref and state
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

        setScalingState(false);

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
      elementListRef,
      setElementList,
      canvasScale,
      activeElementIdList,
      activeGroupElementId,
      viewportRatio,
      viewportSize,
      ctrlOrShiftKeyActive,
      setScalingState,
      setAlignmentLines,
      updateSlide,
      addHistorySnapshot,
    ],
  );

  // Scale multiple selected elements
  const scaleMultiElement = useCallback(
    (e: React.MouseEvent, range: MultiSelectRange, command: OperateResizeHandlers) => {
      let isMouseDown = true;

      const { minX, maxX, minY, maxY } = range;
      const operateWidth = maxX - minX;
      const operateHeight = maxY - minY;
      const aspectRatio = operateWidth / operateHeight;

      const startPageX = e.pageX;
      const startPageY = e.pageY;

      const originElementList: PPTElement[] = JSON.parse(JSON.stringify(elementListRef.current));

      const handleMouseMove = (e: MouseEvent) => {
        if (!isMouseDown) return;

        const currentPageX = e.pageX;
        const currentPageY = e.pageY;

        const x = (currentPageX - startPageX) / canvasScale;
        let y = (currentPageY - startPageY) / canvasScale;

        // Lock aspect ratio, same logic as above
        if (ctrlOrShiftKeyActive) {
          if (
            command === OperateResizeHandlers.RIGHT_BOTTOM ||
            command === OperateResizeHandlers.LEFT_TOP
          )
            y = x / aspectRatio;
          if (
            command === OperateResizeHandlers.LEFT_BOTTOM ||
            command === OperateResizeHandlers.RIGHT_TOP
          )
            y = -x / aspectRatio;
        }

        // Overall range of all selected elements
        let currentMinX = minX;
        let currentMaxX = maxX;
        let currentMinY = minY;
        let currentMaxY = maxY;

        if (command === OperateResizeHandlers.RIGHT_BOTTOM) {
          currentMaxX = maxX + x;
          currentMaxY = maxY + y;
        } else if (command === OperateResizeHandlers.LEFT_BOTTOM) {
          currentMinX = minX + x;
          currentMaxY = maxY + y;
        } else if (command === OperateResizeHandlers.LEFT_TOP) {
          currentMinX = minX + x;
          currentMinY = minY + y;
        } else if (command === OperateResizeHandlers.RIGHT_TOP) {
          currentMaxX = maxX + x;
          currentMinY = minY + y;
        } else if (command === OperateResizeHandlers.TOP) {
          currentMinY = minY + y;
        } else if (command === OperateResizeHandlers.BOTTOM) {
          currentMaxY = maxY + y;
        } else if (command === OperateResizeHandlers.LEFT) {
          currentMinX = minX + x;
        } else if (command === OperateResizeHandlers.RIGHT) {
          currentMaxX = maxX + x;
        }

        // Overall width and height of all selected elements
        const currentOppositeWidth = currentMaxX - currentMinX;
        const currentOppositeHeight = currentMaxY - currentMinY;

        // Ratio of the currently operated element's width/height to the overall width/height of all selected elements
        let widthScale = currentOppositeWidth / operateWidth;
        let heightScale = currentOppositeHeight / operateHeight;

        if (widthScale <= 0) widthScale = 0;
        if (heightScale <= 0) heightScale = 0;

        // Calculate and update the position and size of all selected elements based on the computed ratio
        const newElements = elementListRef.current.map((el) => {
          if ((el.type === 'image' || el.type === 'shape') && activeElementIdList.includes(el.id)) {
            const originElement = originElementList.find((originEl) => originEl.id === el.id) as
              | PPTImageElement
              | PPTShapeElement;
            return {
              ...el,
              width: originElement.width * widthScale,
              height: originElement.height * heightScale,
              left: currentMinX + (originElement.left - minX) * widthScale,
              top: currentMinY + (originElement.top - minY) * heightScale,
            };
          }
          return el;
        });

        elementListRef.current = newElements;
        setElementList(newElements);
      };

      const handleMouseUp = (e: MouseEvent) => {
        isMouseDown = false;
        document.onmousemove = null;
        document.onmouseup = null;

        if (startPageX === e.pageX && startPageY === e.pageY) return;

        updateSlide({ elements: elementListRef.current });
        addHistorySnapshot();
      };

      document.onmousemove = handleMouseMove;
      document.onmouseup = handleMouseUp;
    },
    [
      elementListRef,
      setElementList,
      canvasScale,
      activeElementIdList,
      ctrlOrShiftKeyActive,
      updateSlide,
      addHistorySnapshot,
    ],
  );

  return {
    scaleElement,
    scaleMultiElement,
  };
}
