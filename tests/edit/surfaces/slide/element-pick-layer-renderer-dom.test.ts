// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElementPickLayer } from '@/components/edit/surfaces/slide/ElementPickLayer';
import { editableElementDomId } from '@/components/edit/surfaces/slide/renderer-element-dom';
import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  order: 1,
  title: 'Slide',
  type: 'slide',
  content: {
    type: 'slide',
    canvas: {
      id: 'slide-1',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [
        {
          id: 'title-1',
          type: 'text',
          left: 0,
          top: 0,
          width: 100,
          height: 40,
          rotate: 0,
          content: '<p>Title</p>',
          defaultFontName: 'Inter',
          defaultColor: '#111111',
        },
      ],
    },
  },
  actions: [{ id: 'spotlight-1', type: 'spotlight', elementId: '' }],
} as Scene;

afterEach(() => {
  useCanvasStore.getState().resetCanvasState();
  useStageStore.setState({ scenes: [], currentSceneId: null });
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ElementPickLayer renderer DOM integration', () => {
  it('measures a renderer element host and binds the picked id to the timeline action', async () => {
    useStageStore.setState({ scenes: [scene], currentSceneId: scene.id });
    useCanvasStore.getState().setPickTarget({
      sceneId: scene.id,
      actionId: 'spotlight-1',
      cueType: 'spotlight',
    });

    const rendererHost = document.createElement('div');
    rendererHost.id = editableElementDomId('title-1');
    rendererHost.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 562.5, right: 1000, bottom: 562.5 }) as DOMRect;
    const hitTarget = document.createElement('div');
    hitTarget.className = 'slide-element-hit-target';
    const paintNode = document.createElement('div');
    paintNode.className = 'base-element-text';
    paintNode.getBoundingClientRect = () =>
      ({ left: 40, top: 30, width: 120, height: 50, right: 160, bottom: 80 }) as DOMRect;
    hitTarget.appendChild(paintNode);
    rendererHost.appendChild(hitTarget);
    document.body.appendChild(rendererHost);
    const interactionTarget = document.createElement('div');
    interactionTarget.dataset.selectElementId = 'title-1';
    document.body.appendChild(interactionTarget);
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [interactionTarget],
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(createElement(ElementPickLayer));
    });

    const outline = container.querySelector('.ring-violet-400\\/40') as HTMLElement;
    expect(outline.style.left).toBe('40px');
    expect(outline.style.top).toBe('30px');
    expect(outline.style.width).toBe('120px');
    expect(outline.style.height).toBe('50px');

    const clickCatcher = container.querySelector('.cursor-crosshair') as HTMLElement;
    await act(async () => {
      clickCatcher.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 50 }),
      );
    });
    await act(async () => {
      clickCatcher.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const action = useStageStore.getState().scenes[0].actions?.[0] as { elementId?: string };
    expect(action.elementId).toBe('title-1');
    expect(useCanvasStore.getState().pickTarget).toBeNull();

    await act(async () => root.unmount());
  });
});
