// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { installPageScrollBoundary } from '@/lib/adaptive/page-scroll-boundary';

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  document.body.innerHTML = '';
});
function pan(element: Element, from: number, to: number, fingers = 1) {
  const dispatch = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', {
      value: Array.from({ length: fingers }, () => ({ clientY: y })),
    });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  };
  dispatch('touchstart', from);
  return dispatch('touchmove', to);
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
