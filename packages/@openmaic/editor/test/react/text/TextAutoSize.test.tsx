// @vitest-environment jsdom
import { createRef } from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TextAutoSize } from '../../../src/react/text/TextAutoSize';

let resize: ResizeObserverCallback;

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resize = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

function reportSize(width: number, height: number) {
  act(() => {
    resize([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
  });
}

describe('TextAutoSize', () => {
  beforeEach(() => vi.stubGlobal('ResizeObserver', ResizeObserverMock));

  it('preserves the initial height until editable content changes', () => {
    const onAutoSize = vi.fn();
    const controller = createRef<{ notifyContentChange(): void }>();
    const { rerender } = render(
      <TextAutoSize
        ref={controller}
        elementId="text-1"
        vertical={false}
        width={200}
        height={60}
        resizeActive={false}
        onAutoSize={onAutoSize}
      >
        <span>Text</span>
      </TextAutoSize>,
    );

    reportSize(180, 50);
    expect(onAutoSize).not.toHaveBeenCalled();

    act(() => controller.current?.notifyContentChange());
    reportSize(180, 50);
    expect(onAutoSize).toHaveBeenCalledTimes(1);
    expect(onAutoSize).toHaveBeenLastCalledWith({
      type: 'element.update',
      id: 'text-1',
      props: { height: 70 },
    });

    rerender(
      <TextAutoSize
        ref={controller}
        elementId="text-1"
        vertical={false}
        width={200}
        height={70}
        resizeActive
        onAutoSize={onAutoSize}
      >
        <span>Text</span>
      </TextAutoSize>,
    );
    reportSize(180, 80);
    expect(onAutoSize).toHaveBeenCalledTimes(1);

    rerender(
      <TextAutoSize
        ref={controller}
        elementId="text-1"
        vertical={false}
        width={200}
        height={70}
        resizeActive={false}
        onAutoSize={onAutoSize}
      >
        <span>Text</span>
      </TextAutoSize>,
    );
    expect(onAutoSize).toHaveBeenLastCalledWith({
      type: 'element.update',
      id: 'text-1',
      props: { height: 100 },
    });
  });

  it('emits width for vertical text', () => {
    const onAutoSize = vi.fn();
    const controller = createRef<{ notifyContentChange(): void }>();
    render(
      <TextAutoSize
        ref={controller}
        elementId="text-1"
        vertical
        width={80}
        height={200}
        resizeActive={false}
        onAutoSize={onAutoSize}
      >
        <span>Text</span>
      </TextAutoSize>,
    );

    reportSize(90, 180);
    expect(onAutoSize).not.toHaveBeenCalled();

    act(() => controller.current?.notifyContentChange());
    reportSize(90, 180);
    expect(onAutoSize).toHaveBeenCalledWith({
      type: 'element.update',
      id: 'text-1',
      props: { width: 110 },
    });
  });
});
