import { useCallback } from 'react';
import type { PPTElement, PPTShapeElement } from '@/lib/types/slides';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { SHAPE_PATH_FORMULAS } from '@/configs/shapes';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

interface ShapePathData {
  baseSize: number;
  originPos: number;
  min: number;
  max: number;
  relative: string;
}

/**
 * Move shape keypoint Hook
 *
 * @param elementListRef - Element list ref (used to read the latest value on mouseup)
 * @param setElementList - Element list setter (used to trigger re-render)
 * @param canvasScale - Canvas scale ratio
 */
export function useMoveShapeKeypoint(
  elementListRef: React.RefObject<PPTElement[]>,
  setElementList: React.Dispatch<React.SetStateAction<PPTElement[]>>,
  canvasScale: number,
) {
  const updateSlide = useCanvasOperations().updateSlide;

  const { addHistorySnapshot } = useHistorySnapshot();

  const moveShapeKeypoint = useCallback(
    (e: React.MouseEvent | React.TouchEvent, element: PPTShapeElement, index = 0) => {
      const native = e.nativeEvent;
      const isTouchEvent = native instanceof TouchEvent;
      if (isTouchEvent && !native.changedTouches?.length) return;

      let isMouseDown = true;

      const startPageX = isTouchEvent ? native.changedTouches[0].pageX : native.pageX;
      const startPageY = isTouchEvent ? native.changedTouches[0].pageY : native.pageY;

      const originKeypoints = element.keypoints!;

      const pathFormula = SHAPE_PATH_FORMULAS[element.pathFormula!];
      let shapePathData: ShapePathData | null = null;
      if ('editable' in pathFormula && pathFormula.editable) {
        const getBaseSize = pathFormula.getBaseSize![index];
        const range = pathFormula.range![index];
        const relative = pathFormula.relative![index];
        const keypoint = originKeypoints[index];

        const baseSize = getBaseSize(element.width, element.height);
        const originPos = baseSize * keypoint;
        const [min, max] = range;

        shapePathData = { baseSize, originPos, min, max, relative };
      }

      const handleMouseMove = (e: MouseEvent | TouchEvent) => {
        if (!isMouseDown) return;

        const currentPageX = e instanceof MouseEvent ? e.pageX : e.changedTouches[0].pageX;
        const currentPageY = e instanceof MouseEvent ? e.pageY : e.changedTouches[0].pageY;
        const moveX = (currentPageX - startPageX) / canvasScale;
        const moveY = (currentPageY - startPageY) / canvasScale;

        // Update local element list during mousemove
        const newElements = elementListRef.current.map((el) => {
          if (el.id === element.id && shapePathData) {
            const { baseSize, originPos, min, max, relative } = shapePathData;
            const shapeElement = el as PPTShapeElement;

            let keypoint = 0;

            if (relative === 'center') keypoint = (originPos - moveX * 2) / baseSize;
            else if (relative === 'left') keypoint = (originPos + moveX) / baseSize;
            else if (relative === 'right') keypoint = (originPos - moveX) / baseSize;
            else if (relative === 'top') keypoint = (originPos + moveY) / baseSize;
            else if (relative === 'bottom') keypoint = (originPos - moveY) / baseSize;
            else if (relative === 'left_bottom') keypoint = (originPos + moveX) / baseSize;
            else if (relative === 'right_bottom') keypoint = (originPos - moveX) / baseSize;
            else if (relative === 'top_right') keypoint = (originPos + moveY) / baseSize;
            else if (relative === 'bottom_right') keypoint = (originPos - moveY) / baseSize;

            if (keypoint < min) keypoint = min;
            if (keypoint > max) keypoint = max;

            let keypoints: number[] = [];
            if (Array.isArray(originKeypoints)) {
              keypoints = [...originKeypoints];
              keypoints[index] = keypoint;
            } else keypoints = [keypoint];

            return {
              ...el,
              keypoints,
              path: pathFormula.formula(shapeElement.width, shapeElement.height, keypoints),
            };
          }
          return el;
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
    [elementListRef, setElementList, canvasScale, updateSlide, addHistorySnapshot],
  );

  return {
    moveShapeKeypoint,
  };
}
