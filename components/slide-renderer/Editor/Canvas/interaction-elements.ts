import type { PPTElement } from '@openmaic/dsl';
import { RENDER_PATH_LIMITS, shapeToTextFallback, validateShapeGeometry } from '@openmaic/geometry';

/** Match recovered text bounds while retaining the stored shape's geometry. */
export function projectInteractionElement(element: PPTElement): PPTElement | null {
  if (element.type !== 'shape' || validateShapeGeometry(element, RENDER_PATH_LIMITS).ok)
    return element;
  const fallback = shapeToTextFallback(element);
  return fallback
    ? {
        ...element,
        left: fallback.left,
        top: fallback.top,
        width: fallback.width,
        height: fallback.height,
        rotate: fallback.rotate,
      }
    : null;
}

export function projectInteractionElements(elements: PPTElement[]): PPTElement[] {
  return elements.flatMap((element) => {
    const projected = projectInteractionElement(element);
    return projected ? [projected] : [];
  });
}
