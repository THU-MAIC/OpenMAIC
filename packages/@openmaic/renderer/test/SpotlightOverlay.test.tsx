// @vitest-environment jsdom
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SpotlightOverlay } from '../src/effects/SpotlightOverlay';

const observers: Array<{
  callback: ResizeObserverCallback;
  observed: Element[];
}> = [];

class ResizeObserverMock {
  readonly callback: ResizeObserverCallback;
  readonly observed: Element[] = [];

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }

  observe(element: Element) {
    this.observed.push(element);
  }

  unobserve() {}
  disconnect() {}
}

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  };
}

describe('SpotlightOverlay', () => {
  afterEach(() => {
    observers.length = 0;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('remeasures when the spotlight target changes size', async () => {
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);

    const target = document.createElement('div');
    target.id = 'slide-element-target';
    const content = document.createElement('div');
    content.className = 'element-content';
    target.appendChild(content);
    document.body.appendChild(target);

    let targetRect = rect(10, 20, 30, 40);
    vi.spyOn(content, 'getBoundingClientRect').mockImplementation(() => targetRect);

    const { container } = render(<SpotlightOverlay options={{ elementId: 'target' }} />);
    const overlay = container.firstElementChild as HTMLDivElement;
    vi.spyOn(overlay, 'getBoundingClientRect').mockReturnValue(rect(0, 0, 100, 100));

    act(() => {
      observers.forEach(({ callback }) => callback([], {} as ResizeObserver));
    });

    await waitFor(() =>
      expect(container.querySelector('mask rect:nth-child(2)')?.getAttribute('style')).toContain(
        'translateX(9.6px)',
      ),
    );

    targetRect = rect(40, 30, 20, 10);
    act(() => {
      observers.forEach(({ callback }) => callback([], {} as ResizeObserver));
    });

    await waitFor(() =>
      expect(container.querySelector('mask rect:nth-child(2)')?.getAttribute('style')).toContain(
        'translateX(39.6px)',
      ),
    );
  });
});
