// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Slide, PPTTextElement, PPTVideoElement } from '../../dsl/src';
import { SlideCanvas } from '../src/SlideCanvas';

const textElement: PPTTextElement = {
  id: 'title-1',
  type: 'text',
  left: 24,
  top: 32,
  width: 120,
  height: 48,
  rotate: 0,
  content: '<p>Hello</p>',
  defaultFontName: 'Arial',
  defaultColor: '#111111',
};

const slide: Slide = {
  id: 'slide-1',
  viewportSize: 1000,
  viewportRatio: 0.5625,
  elements: [textElement],
  theme: {
    fontName: 'Arial',
    fontColor: '#111111',
    backgroundColor: '#ffffff',
    themeColors: ['#111111'],
  },
  background: { type: 'solid', color: '#ffffff' },
};

describe('SlideCanvas', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('passes a custom element id prefix to rendered elements for host overlays', () => {
    const html = renderToStaticMarkup(
      createElement(SlideCanvas, {
        slide,
        scale: 1,
        chrome: false,
        elementIdPrefix: 'screen-element-',
      }),
    );

    expect(html).toContain('id="screen-element-title-1"');
  });

  it('does not report an auto-fit scale when a fixed scale is provided', () => {
    const onScaleChange = vi.fn();

    render(<SlideCanvas slide={slide} scale={1} onScaleChange={onScaleChange} />);

    expect(onScaleChange).not.toHaveBeenCalled();
  });

  it('does not report the same auto-fit scale twice', () => {
    let resizeCallback: ResizeObserverCallback | undefined;
    class ResizeObserverMock {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback;
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(562.5);
    const onScaleChange = vi.fn();

    render(<SlideCanvas slide={slide} onScaleChange={onScaleChange} />);
    expect(onScaleChange).toHaveBeenCalledTimes(1);

    act(() => {
      resizeCallback?.([], {} as ResizeObserver);
    });

    expect(onScaleChange).toHaveBeenCalledTimes(1);
  });

  it('reports the current scale when auto-fit is re-enabled', () => {
    class ResizeObserverMock {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(562.5);
    const onScaleChange = vi.fn();

    const { rerender } = render(<SlideCanvas slide={slide} onScaleChange={onScaleChange} />);
    expect(onScaleChange).toHaveBeenCalledTimes(1);

    rerender(<SlideCanvas slide={slide} scale={1} onScaleChange={onScaleChange} />);
    expect(onScaleChange).toHaveBeenCalledTimes(1);

    rerender(<SlideCanvas slide={slide} onScaleChange={onScaleChange} />);
    expect(onScaleChange).toHaveBeenCalledTimes(2);
    expect(onScaleChange).toHaveBeenLastCalledWith(1);
  });

  it('keeps video content interactive by default when element clicks are enabled', () => {
    const videoElement: PPTVideoElement = {
      id: 'video-1',
      type: 'video',
      left: 0,
      top: 0,
      width: 160,
      height: 90,
      rotate: 0,
      src: 'video.mp4',
      autoplay: false,
    };
    const videoSlide = { ...slide, elements: [videoElement] };

    const { container } = render(
      <SlideCanvas slide={videoSlide} scale={1} onElementClick={vi.fn()} />,
    );

    expect(
      container.querySelector<HTMLElement>('.slide-element-hit-target')?.style.pointerEvents,
    ).toBe('auto');
    expect(container.querySelector<HTMLElement>('[data-video-element]')?.style.pointerEvents).toBe(
      'auto',
    );
  });

  it('keeps video content non-interactive when requested', () => {
    const videoElement: PPTVideoElement = {
      id: 'video-1',
      type: 'video',
      left: 0,
      top: 0,
      width: 160,
      height: 90,
      rotate: 0,
      src: 'video.mp4',
      autoplay: false,
    };
    const videoSlide = { ...slide, elements: [videoElement] };

    const { container } = render(
      <SlideCanvas
        slide={videoSlide}
        scale={1}
        onElementClick={vi.fn()}
        videoInteractive={false}
      />,
    );

    expect(container.querySelector<HTMLElement>('[data-video-element]')?.style.pointerEvents).toBe(
      'none',
    );
  });
});
