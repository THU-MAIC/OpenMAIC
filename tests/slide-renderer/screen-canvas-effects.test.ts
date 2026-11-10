// @vitest-environment jsdom
import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneProvider, type SceneDataController } from '@/lib/contexts/scene-context';
import { ScreenCanvas } from '@/components/slide-renderer/Editor/ScreenCanvas';
import { useCanvasStore } from '@/lib/store/canvas';
import type { SlideContent } from '@/lib/types/stage';
import type { PercentageGeometry } from '@/lib/types/action';

const laserGeometries: PercentageGeometry[] = [];

vi.mock('@/components/slide-renderer/Editor/LaserOverlay', () => ({
  LaserOverlay: ({ geometry }: { geometry: PercentageGeometry }) => {
    laserGeometries.push(geometry);
    return null;
  },
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A 1280 x 720 slide whose only element is centered at (640, 360).
const content: SlideContent = {
  type: 'slide',
  canvas: {
    id: 'slide-1',
    viewportSize: 1280,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#ffffff' },
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements: [
      {
        id: 'box',
        type: 'text',
        left: 576,
        top: 312,
        width: 128,
        height: 96,
        rotate: 0,
        content: '<p>Hello</p>',
        defaultFontName: 'Arial',
        defaultColor: '#111111',
      },
    ],
  },
};

const controller: SceneDataController<SlideContent> = {
  sceneId: 'scene-1',
  sceneType: 'slide',
  getSnapshot: () => content,
  updateSceneData: () => {},
};

const TestSceneProvider = SceneProvider as ComponentType<{
  controller?: SceneDataController;
  children?: ReactNode;
}>;

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('legacy ScreenCanvas effects on a non-1000px slide', () => {
  let container: HTMLDivElement;
  let root: Root;
  const initial = useCanvasStore.getState();

  beforeEach(() => {
    laserGeometries.length = 0;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    // The slide frame is 1280 x 720 on screen; the element's rendered box is
    // centered in it. Everything else reports the frame box.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.closest('#screen-element-box')) return rect(576, 312, 128, 96);
      return rect(0, 0, 1280, 720);
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    useCanvasStore.setState({
      viewportSize: initial.viewportSize,
      viewportRatio: initial.viewportRatio,
      zoomTarget: initial.zoomTarget,
      laserElementId: initial.laserElementId,
      laserOptions: initial.laserOptions,
    });
  });

  function render() {
    act(() => {
      root.render(
        createElement(
          TestSceneProvider,
          { controller: controller as SceneDataController },
          createElement(ScreenCanvas),
        ),
      );
    });
  }

  it('places the laser at the measured element center, not an inset 1000px estimate', () => {
    useCanvasStore.setState({ laserElementId: 'box', laserOptions: { color: '#ff0000' } });
    render();

    const geometry = laserGeometries.at(-1);
    expect(geometry?.centerX).toBeCloseTo(50);
    expect(geometry?.centerY).toBeCloseTo(50);
    expect(container.innerHTML).not.toContain('padding: 5%');
  });

  it('zooms toward the element using the slide viewport size', () => {
    useCanvasStore.setState({ zoomTarget: { elementId: 'box', scale: 1.5 } });
    render();

    const frame = container.querySelector<HTMLElement>('.legacy-screen-canvas > div:not(style)');
    expect(frame?.style.transform).toBe('scale(1.5)');
    expect(frame?.style.transformOrigin).toBe('50% 50%');
  });
});
