// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ElementPickLayer } from '@/components/edit/surfaces/slide/ElementPickLayer';
import {
  editableElementDomId,
  maicElementIdAttributes,
} from '@/components/edit/surfaces/slide/renderer-element-dom';
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
  useStageStore.setState({ stage: null, scenes: [], currentSceneId: null });
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('ElementPickLayer renderer DOM integration', () => {
  it('measures a renderer element host and binds the picked id to the timeline action', async () => {
    useStageStore.setState({
      stage: { id: 'stage-1' } as never,
      scenes: [scene],
      currentSceneId: scene.id,
    });
    useCanvasStore.getState().setPickTarget({
      purpose: 'cue',
      stageId: 'stage-1',
      sceneId: scene.id,
      actionId: 'spotlight-1',
      cueType: 'spotlight',
    });

    const rendererHost = document.createElement('div');
    rendererHost.id = editableElementDomId('title-1');
    for (const [name, value] of Object.entries(maicElementIdAttributes('title-1'))) {
      rendererHost.setAttribute(name, value);
    }
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
    Object.defineProperty(document, 'elementsFromPoint', {
      configurable: true,
      value: () => [paintNode],
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

    const clickCatcher = document.querySelector('.cursor-crosshair') as HTMLElement;
    // Pick mode leaves the slide alone until the pointer names an element.
    expect(document.querySelector('.ring-violet-500')).toBeNull();
    await act(async () => {
      clickCatcher.dispatchEvent(
        new MouseEvent('mousemove', { bubbles: true, clientX: 60, clientY: 50 }),
      );
    });

    // The ring is measured off the renderer's paint node, 2px outside it.
    const ring = document.querySelector('.ring-violet-500') as HTMLElement;
    expect(ring.style.left).toBe('38px');
    expect(ring.style.top).toBe('28px');
    expect(ring.style.width).toBe('124px');
    expect(ring.style.height).toBe('54px');

    await act(async () => {
      clickCatcher.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const action = useStageStore.getState().scenes[0].actions?.[0] as { elementId?: string };
    expect(action.elementId).toBe('title-1');
    expect(useCanvasStore.getState().pickTarget).toBeNull();

    await act(async () => root.unmount());
  });
});
