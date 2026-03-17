import { useCallback, type RefObject } from 'react';
import type {
  PPTElement,
  PPTLineElement,
  PPTVideoElement,
  PPTAudioElement,
  PPTChartElement,
} from '@/lib/types/slides';
import { useHistorySnapshot } from '@/lib/hooks/use-history-snapshot';
import { useCanvasOperations } from '@/lib/hooks/use-canvas-operations';

/**
 * Calculate the angle (in radians) of the line from the origin to the given coordinates
 * @param x Coordinate x
 * @param y Coordinate y
 */
const getAngleFromCoordinate = (x: number, y: number) => {
  const radian = Math.atan2(x, y);
  const angle = (180 / Math.PI) * radian;
  return angle;
};

/**
 * Rotate element Hook
 *
 * @param elementListRef - Element list ref (stores the latest value)
 * @param setElementList - Element list setter (used to trigger re-render)
 * @param viewportRef - Viewport reference
 * @param canvasScale - Canvas scale ratio
 */
export function useRotateElement(
  elementListRef: React.RefObject<PPTElement[]>,
  setElementList: React.Dispatch<React.SetStateAction<PPTElement[]>>,
  viewportRef: RefObject<HTMLElement | null>,
  canvasScale: number,
) {
  const updateSlide = useCanvasOperations().updateSlide;

  const { addHistorySnapshot } = useHistorySnapshot();

  // Rotate element
  const rotateElement = useCallback(
    (
      e: React.MouseEvent | React.TouchEvent,
      element: Exclude<
        PPTElement,
        PPTChartElement | PPTLineElement | PPTVideoElement | PPTAudioElement
      >,
    ) => {
      const native = e.nativeEvent;
      const isTouchEvent = native instanceof TouchEvent;
      if (isTouchEvent && !native.changedTouches?.length) return;

      let isMouseDown = true;
      let angle = 0;
      const elOriginRotate = element.rotate || 0;

      const elLeft = element.left;
      const elTop = element.top;
      const elWidth = element.width;
      const elHeight = element.height;

      // Element center point (rotation center)
      const centerX = elLeft + elWidth / 2;
      const centerY = elTop + elHeight / 2;

      if (!viewportRef.current) return;
      const viewportRect = viewportRef.current.getBoundingClientRect();

      const handleMouseMove = (e: MouseEvent | TouchEvent) => {
        if (!isMouseDown) return;

        const currentPageX = e instanceof MouseEvent ? e.pageX : e.changedTouches[0].pageX;
        const currentPageY = e instanceof MouseEvent ? e.pageY : e.changedTouches[0].pageY;

        // Calculate the angle of the line from the current mouse position to the element center
        const mouseX = (currentPageX - viewportRect.left) / canvasScale;
        const mouseY = (currentPageY - viewportRect.top) / canvasScale;
        const x = mouseX - centerX;
        const y = centerY - mouseY;

        angle = getAngleFromCoordinate(x, y);

        // Snap to multiples of 45 degrees when close
        const sorptionRange = 5;
        if (Math.abs(angle) <= sorptionRange) angle = 0;
        else if (angle > 0 && Math.abs(angle - 45) <= sorptionRange) angle -= angle - 45;
        else if (angle < 0 && Math.abs(angle + 45) <= sorptionRange) angle -= angle + 45;
        else if (angle > 0 && Math.abs(angle - 90) <= sorptionRange) angle -= angle - 90;
        else if (angle < 0 && Math.abs(angle + 90) <= sorptionRange) angle -= angle + 90;
        else if (angle > 0 && Math.abs(angle - 135) <= sorptionRange) angle -= angle - 135;
        else if (angle < 0 && Math.abs(angle + 135) <= sorptionRange) angle -= angle + 135;
        else if (angle > 0 && Math.abs(angle - 180) <= sorptionRange) angle -= angle - 180;
        else if (angle < 0 && Math.abs(angle + 180) <= sorptionRange) angle -= angle + 180;

        const newElements = elementListRef.current.map((el) => {
          if (el.id === element.id && 'rotate' in el) {
            return { ...el, rotate: angle };
          }
          return el;
        });

        // Update both ref and state
        elementListRef.current = newElements;
        setElementList(newElements);
      };

      const handleMouseUp = () => {
        isMouseDown = false;
        document.onmousemove = null;
        document.onmouseup = null;
        document.ontouchmove = null;
        document.ontouchend = null;

        if (elOriginRotate === angle) return;

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
    [elementListRef, setElementList, viewportRef, canvasScale, updateSlide, addHistorySnapshot],
  );

  return {
    rotateElement,
  };
}
