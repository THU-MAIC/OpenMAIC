import type { PPTElement } from '@/lib/types/slides';
import type { PercentageGeometry } from '@/lib/types/action';

/**
 * Calculate percentage coordinates (0-100) for an element
 *
 * @param element - PPT element
 * @param viewportSize - Viewport width base, default 1000px
 * @returns Percentage geometry info, or null if the element has no position info
 */
export function getElementPercentageGeometry(
  element: PPTElement,
  viewportSize: number = 1000,
): PercentageGeometry | null {
  // Only positioned elements have left/top/width/height
  if (
    !('left' in element) ||
    !('top' in element) ||
    !('width' in element) ||
    !('height' in element)
  ) {
    return null;
  }

  const { left, top, width, height } = element;

  // Calculate percentage coordinates (relative to viewportSize)
  const x = (left / viewportSize) * 100;
  const y = (top / (viewportSize * 0.5625)) * 100; // 16:9 ratio
  const w = (width / viewportSize) * 100;
  const h = (height / (viewportSize * 0.5625)) * 100;

  // Calculate center point
  const centerX = x + w / 2;
  const centerY = y + h / 2;

  return {
    x,
    y,
    w,
    h,
    centerX,
    centerY,
  };
}

/**
 * Find percentage geometry info by scene and element ID
 *
 * @param scene - Scene object
 * @param elementId - Element ID
 * @param viewportSize - Viewport width base, default 1000px
 * @returns Percentage geometry info, or null if element is not found or has no position info
 */
export function findElementGeometry(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- scene can be old or new format with different shapes
  scene: Record<string, any>,
  elementId: string,
  viewportSize: number = 1000,
): PercentageGeometry | null {
  // Support two scene structures:
  // 1. scene.elements (old format)
  // 2. scene.content.canvas.elements (new format)
  let elements: PPTElement[] | undefined;

  if (scene.type === 'slide') {
    if (scene.elements) {
      // Old format
      elements = scene.elements;
    } else if (scene.content?.canvas?.elements) {
      // New format
      elements = scene.content.canvas.elements;
    }
  }

  if (!elements) {
    return null;
  }

  const element = elements.find((el: PPTElement) => el.id === elementId);
  if (!element) {
    return null;
  }

  return getElementPercentageGeometry(element, viewportSize);
}

/**
 * Calculate which corner has the shortest distance to the element center
 *
 * @param geometry - Percentage geometry info
 * @returns Nearest corner coordinates { x: 0-100, y: 0-100 }
 */
export function findNearestCorner(geometry: PercentageGeometry): {
  x: number;
  y: number;
} {
  const { centerX, centerY } = geometry;

  // Coordinates of the four corners
  const corners = [
    { x: 0, y: 0 }, // Top-left
    { x: 100, y: 0 }, // Top-right
    { x: 0, y: 100 }, // Bottom-left
    { x: 100, y: 100 }, // Bottom-right
  ];

  // Calculate distances and find the nearest corner
  let minDistance = Infinity;
  let nearestCorner = corners[0];

  for (const corner of corners) {
    const distance = Math.sqrt(Math.pow(corner.x - centerX, 2) + Math.pow(corner.y - centerY, 2));
    if (distance < minDistance) {
      minDistance = distance;
      nearestCorner = corner;
    }
  }

  return nearestCorner;
}
