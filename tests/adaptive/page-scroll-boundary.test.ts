// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installPageScrollBoundary } from '@/lib/adaptive/page-scroll-boundary';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  document.body.innerHTML = '';
});
function pan2D(
  element: Element,
  from: { x: number; y: number },
  to: { x: number; y: number },
  fingers = 1,
) {
  const dispatch = (type: string, point: { x: number; y: number }) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
      value: Array.from({ length: fingers }, () => ({ clientX: point.x, clientY: point.y })),
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  };
  dispatch('touchstart', from);
  return dispatch('touchmove', to);
}
function pan(element: Element, from: number, to: number, fingers = 1) {
  return pan2D(element, { x: 100, y: from }, { x: 100, y: to }, fingers);
}
function horizontalScrollable(direction = 'ltr') {
  const element = document.createElement('div');
  element.style.cssText = `overflow-x: auto; overflow-y: hidden; direction: ${direction}`;
  Object.defineProperties(element, {
    clientWidth: { value: 100 },
    scrollWidth: { value: 300 },
  });
  document.body.append(element);
  return element;
}
function scrollable() {
  const element = document.createElement('div');
  element.style.overflowY = 'auto';
  Object.defineProperties(element, {
    clientHeight: { value: 100 },
    scrollHeight: { value: 300 },
  });
  document.body.append(element);
  return element;
}
describe('fixed phone page scroll boundary', () => {
  it('blocks page panning and removes listeners on cleanup', () => {
    cleanup = installPageScrollBoundary(document);
    expect(pan(document.body, 100, 150)).toBe(true);
    expect(pan(document.body, 150, 100)).toBe(true);
    cleanup();
    expect(pan(document.body, 100, 150)).toBe(false);
  });
  it('retains two-finger zoom', () => {
    cleanup = installPageScrollBoundary(document);
    expect(pan(document.body, 100, 150, 2)).toBe(false);
  });
  it('allows nested content to scroll in both directions away from its boundaries', () => {
    const element = scrollable();
    element.scrollTop = 100;
    cleanup = installPageScrollBoundary(document);
    expect(pan(element, 100, 150)).toBe(false);
    expect(pan(element, 150, 100)).toBe(false);
  });
  it('blocks outward drags at scroll boundaries but permits scrolling back inward', () => {
    const element = scrollable();
    cleanup = installPageScrollBoundary(document);
    expect(pan(element, 100, 150)).toBe(true);
    expect(pan(element, 150, 100)).toBe(false);
    element.scrollTop = 200;
    expect(pan(element, 150, 100)).toBe(true);
    expect(pan(element, 100, 150)).toBe(false);
  });
  it('lets an outer dialog scroll when its inner field reaches an edge', () => {
    const dialog = scrollable();
    const field = scrollable();
    dialog.append(field);
    dialog.scrollTop = 100;
    cleanup = installPageScrollBoundary(document);
    expect(pan(field, 100, 150)).toBe(false);
  });
});

describe('horizontal nested controls', () => {
  it('allows horizontal swipes with slight vertical drift in both directions', () => {
    const element = horizontalScrollable();
    element.scrollLeft = 100;
    cleanup = installPageScrollBoundary(document);
    expect(pan2D(element, { x: 150, y: 100 }, { x: 50, y: 103 })).toBe(false);
    expect(pan2D(element, { x: 50, y: 100 }, { x: 150, y: 97 })).toBe(false);
  });
  it('blocks outward horizontal swipes but permits inward swipes at LTR edges', () => {
    const element = horizontalScrollable();
    cleanup = installPageScrollBoundary(document);
    expect(pan2D(element, { x: 100, y: 100 }, { x: 150, y: 102 })).toBe(true);
    expect(pan2D(element, { x: 100, y: 100 }, { x: 50, y: 102 })).toBe(false);
    element.scrollLeft = 200;
    expect(pan2D(element, { x: 100, y: 100 }, { x: 50, y: 102 })).toBe(true);
    expect(pan2D(element, { x: 100, y: 100 }, { x: 150, y: 102 })).toBe(false);
  });
  it('handles RTL negative scrollLeft at both edges and in the middle', () => {
    const element = horizontalScrollable('rtl');
    cleanup = installPageScrollBoundary(document);
    expect(pan2D(element, { x: 100, y: 100 }, { x: 150, y: 102 })).toBe(false);
    expect(pan2D(element, { x: 100, y: 100 }, { x: 50, y: 102 })).toBe(true);
    element.scrollLeft = -200;
    expect(pan2D(element, { x: 100, y: 100 }, { x: 50, y: 102 })).toBe(false);
    expect(pan2D(element, { x: 100, y: 100 }, { x: 150, y: 102 })).toBe(true);
    element.scrollLeft = -100;
    expect(pan2D(element, { x: 100, y: 100 }, { x: 50, y: 102 })).toBe(false);
    expect(pan2D(element, { x: 100, y: 100 }, { x: 150, y: 102 })).toBe(false);
  });
  it('allows a horizontal ancestor to consume the gesture when its child reaches an edge', () => {
    const outer = horizontalScrollable();
    const inner = horizontalScrollable();
    outer.append(inner);
    outer.scrollLeft = 100;
    inner.scrollLeft = 200;
    cleanup = installPageScrollBoundary(document);
    expect(pan2D(inner, { x: 150, y: 100 }, { x: 50, y: 103 })).toBe(false);
  });
  it('does not release a horizontal edge swipe just because an ancestor can scroll vertically', () => {
    const outer = scrollable();
    const inner = horizontalScrollable();
    outer.append(inner);
    outer.scrollTop = 100;
    cleanup = installPageScrollBoundary(document);
    expect(pan2D(inner, { x: 50, y: 100 }, { x: 150, y: 103 })).toBe(true);
  });
  it('does not release a mostly vertical swipe in a horizontal-only control', () => {
    const element = horizontalScrollable();
    element.scrollLeft = 100;
    cleanup = installPageScrollBoundary(document);
    expect(pan2D(element, { x: 100, y: 150 }, { x: 103, y: 50 })).toBe(true);
  });
  it('contains horizontal background panning, including perfectly horizontal gestures', () => {
    cleanup = installPageScrollBoundary(document);
    expect(pan2D(document.body, { x: 150, y: 100 }, { x: 50, y: 100 })).toBe(true);
    expect(pan2D(document.body, { x: 50, y: 100 }, { x: 150, y: 103 })).toBe(true);
    expect(pan2D(document.body, { x: 50, y: 100 }, { x: 150, y: 103 }, 2)).toBe(false);
  });
});
