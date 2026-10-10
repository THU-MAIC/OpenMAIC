/**
 * Tell a touch event from a mouse event without the `TouchEvent` global.
 *
 * Desktop Safari does not implement the Touch Events API, so `TouchEvent` is
 * not defined there and an `instanceof` test against it throws a
 * ReferenceError on every mouse-down. The canvas gesture hooks used that
 * check, which made every element drag, resize, rotate and shape-keypoint
 * gesture fail in Safari. A touch event is recognised by its
 * `changedTouches` list instead.
 */
export function isTouchEvent(e: MouseEvent | TouchEvent): e is TouchEvent {
  return 'changedTouches' in e;
}
