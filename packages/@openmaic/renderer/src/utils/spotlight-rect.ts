// Translation and transform-origin affect the center, which the browser already
// measures. Only the linear part is needed for center deltas and box dimensions.
function linearTransform(element: Element) {
  let matrix: DOMMatrix | undefined;
  for (let node: Element | null = element; node; node = node.parentElement) {
    const transform = getComputedStyle(node).transform;
    if (transform && transform !== 'none') {
      const parent = new DOMMatrix(transform);
      matrix = matrix ? parent.multiply(matrix) : parent;
    }
  }
  if (matrix) return new DOMMatrix([matrix.a, matrix.b, matrix.c, matrix.d, 0, 0]);
}

/** Measure the target's rendered border box in the overlay's 0–100 viewBox. */
export function measureSpotlightRect(overlay: HTMLElement, target: Element) {
  const frame = overlay.getBoundingClientRect();
  const box = target.getBoundingClientRect();
  if (!frame.width || !frame.height) return null;

  const axes = linearTransform(overlay);
  if (!axes || (!axes.b && !axes.c && axes.a > 0 && axes.d > 0)) {
    return {
      x: ((box.left - frame.left) / frame.width) * 100,
      y: ((box.top - frame.top) / frame.height) * 100,
      w: (box.width / frame.width) * 100,
      h: (box.height / frame.height) * 100,
    };
  }

  if (!(target instanceof HTMLElement) || !overlay.clientWidth || !overlay.clientHeight)
    return null;
  // The center survives rotation, whereas the corners of a viewport-aligned
  // bounding rect no longer correspond to the corners of the target.
  const inverse = axes.inverse();
  const center = inverse.transformPoint({
    x: box.left + box.width / 2 - (frame.left + frame.width / 2),
    y: box.top + box.height / 2 - (frame.top + frame.height / 2),
  });
  const local = inverse.multiply(linearTransform(target));
  const width = Math.abs(local.a) * target.offsetWidth + Math.abs(local.c) * target.offsetHeight;
  const height = Math.abs(local.b) * target.offsetWidth + Math.abs(local.d) * target.offsetHeight;
  return {
    x: 50 + ((center.x - width / 2) / overlay.clientWidth) * 100,
    y: 50 + ((center.y - height / 2) / overlay.clientHeight) * 100,
    w: (width / overlay.clientWidth) * 100,
    h: (height / overlay.clientHeight) * 100,
  };
}
