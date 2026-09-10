// @vitest-environment jsdom

import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneProvider, type SceneDataController } from '@/lib/contexts/scene-context';
import { PlaybackScreenCanvas } from '@/components/slide-renderer/Editor/ScreenCanvas';
import { SlideElementPickOverlay } from '@/components/canvas/slide-element-pick-overlay';
import type { Scene, SlideContent } from '@/lib/types/stage';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const textElement = {
  id: 'text-1',
  type: 'text',
  left: 24,
  top: 32,
  width: 120,
  height: 48,
  rotate: 0,
  content: '<p>Production renderer</p>',
  defaultFontName: 'Arial',
  defaultColor: '#111111',
} as const;

const content: SlideContent = {
  type: 'slide',
  canvas: {
    id: 'slide-1',
    viewportSize: 1000,
    viewportRatio: 0.5625,
    background: { type: 'solid', color: '#ffffff' },
    theme: {
      fontName: 'Arial',
      fontColor: '#111111',
      backgroundColor: '#ffffff',
      themeColors: ['#111111'],
    },
    elements: [textElement],
  },
};

const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  title: 'Renderer differential',
  order: 0,
  type: 'slide',
  content,
} as Extract<Scene, { type: 'slide' }>;

const controller: SceneDataController<SlideContent> = {
  sceneId: scene.id,
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
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

class TestResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

describe.each([
  ['Legacy', undefined],
  ['New', 'true'],
] as const)('SlideElementPickOverlay with the real %s playback renderer', (_name, flag) => {
  const rendererFlag = 'NEXT_PUBLIC_MAIC_PLAYBACK_RENDERER_ENABLED';
  let originalFlag: string | undefined;
  let container: HTMLDivElement;
  let root: Root;
  let frames: FrameRequestCallback[];

  beforeEach(() => {
    originalFlag = process.env[rendererFlag];
    if (flag === undefined) delete process.env[rendererFlag];
    else process.env[rendererFlag] = flag;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    frames = [];
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.dataset.testid === 'slide-element-pick-overlay') return rect(0, 0, 800, 450);
      if (this.classList.contains('base-element-text')) return rect(80, 60, 120, 48);
      if (this.classList.contains('slide-element')) return rect(0, 0, 800, 450);
      if (this.classList.contains('screen-element')) return rect(0, 0, 0, 0);
      return rect(0, 0, 800, 450);
    });
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: vi.fn(() => {
        throw new Error('real renderer selection must use paint geometry');
      }),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    if (originalFlag === undefined) delete process.env[rendererFlag];
    else process.env[rendererFlag] = originalFlag;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('selects from the renderer paint node and outlines that node geometry', () => {
    const onPick = vi.fn();
    act(() => {
      root.render(
        createElement(
          TestSceneProvider,
          { controller },
          createElement(
            'div',
            null,
            createElement(PlaybackScreenCanvas),
            createElement(SlideElementPickOverlay, { scene, onPick, onCancel: vi.fn() }),
          ),
        ),
      );
    });
    const initialFrames = frames.splice(0);
    act(() => initialFrames.forEach((callback) => callback(0)));

    if (flag) {
      expect(
        container.querySelector('.slide-element-hit-target .base-element-text'),
      ).not.toBeNull();
      expect(
        (document.getElementById('screen-element-text-1') as HTMLElement).style.pointerEvents,
      ).toBe('none');
    } else {
      expect(container.querySelector('#screen-element-text-1 > .base-element-text')).not.toBeNull();
    }

    const outline = container.querySelector('.border-violet-400\\/70') as HTMLElement;
    expect(outline.style.cssText).toContain('left: 80px');
    expect(outline.style.cssText).toContain('top: 60px');
    expect(outline.style.cssText).toContain('width: 120px');

    act(() => {
      container.querySelector('[data-testid="slide-element-pick-overlay"]')!.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: 100,
          clientY: 80,
        }),
      );
    });

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'text-1' }));
    expect(document.elementsFromPoint).not.toHaveBeenCalled();
  });
});
