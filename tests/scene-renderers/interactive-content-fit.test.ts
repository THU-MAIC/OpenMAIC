// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InteractiveIframeHost } from '@/components/scene-renderers/InteractiveIframeHost';
import { useInteractiveIframePool } from '@/lib/store/interactive-iframe-pool';
import { useSceneRuntimeErrors } from '@/lib/store/scene-runtime-errors';
import { useWidgetIframeStore } from '@/lib/store/widget-iframe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => (key === 'chat.interactiveMoreBelow' ? 'More below' : key),
  }),
}));

const resetPool = useInteractiveIframePool.getState().reset;
const SLOT = { left: 0, top: 0, width: 1280, height: 720 };

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderHost() {
  useInteractiveIframePool.setState({
    entries: {
      'scene-a': { srcDoc: '<div>Tall</div>', rect: SLOT, clip: SLOT, owner: 'o', tick: 1 },
    },
    activeSceneId: 'scene-a',
    tick: 1,
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(InteractiveIframeHost));
    await Promise.resolve();
  });
}

function iframe(): HTMLIFrameElement {
  return document.querySelector('iframe')!;
}

async function report(
  content: { width: number; height: number },
  scrollRemaining = 0,
  source: MessageEventSource | null = iframe().contentWindow,
) {
  const frame = iframe();
  await act(async () => {
    window.dispatchEvent(
      new MessageEvent('message', {
        source,
        data: {
          __maicInteractive: true,
          kind: 'content-extent',
          viewportWidth: Number.parseFloat(frame.style.width),
          viewportHeight: Number.parseFloat(frame.style.height),
          contentWidth: content.width,
          contentHeight: content.height,
          scrollRemaining,
        },
      }),
    );
  });
}

function cue() {
  return document.querySelector<HTMLButtonElement>('[data-testid="interactive-more-below"]');
}

describe('interactive frame fit to content', () => {
  beforeEach(() => {
    useInteractiveIframePool.setState({ reset: resetPool });
    resetPool();
    useSceneRuntimeErrors.setState({ errors: {} });
    useWidgetIframeStore.setState({
      sendMessageByScene: {},
      documentTokenByScene: {},
      readyByScene: {},
      pendingMessagesByScene: {},
      activeSceneId: null,
    });
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    resetPool();
  });

  it('shrinks the frame so a taller page fits without scrolling', async () => {
    await renderHost();
    expect(iframe().style.transform).toBe('scale(1)');
    await report({ width: 1280, height: 900 }, 180);
    expect(iframe().style.transform).toBe('scale(0.8)');
    expect(Number.parseFloat(iframe().style.height)).toBeCloseTo(900);
    expect(Number.parseFloat(iframe().style.width)).toBeCloseTo(1600);
    // The wrap still covers exactly the slot.
    expect(iframe().parentElement?.style.width).toBe('1280px');
    expect(cue()).toBeNull();
  });

  it('ignores extent reports from other windows', async () => {
    await renderHost();
    await report({ width: 1280, height: 900 }, 180, window);
    expect(iframe().style.transform).toBe('scale(1)');
  });

  it('stops at the floor scale and shows a cue that hides at the end of the page', async () => {
    await renderHost();
    await report({ width: 1280, height: 1600 }, 880);
    expect(iframe().style.transform).toBe('scale(0.75)');
    expect(cue()).toBeNull();
    await report({ width: 1707, height: 1600 }, 640);
    expect(iframe().style.transform).toBe('scale(0.75)');
    expect(cue()?.textContent).toContain('More below');
    expect(cue()?.closest('iframe')).toBeNull();

    const post = vi.spyOn(iframe().contentWindow!, 'postMessage');
    act(() => cue()?.click());
    expect(post).toHaveBeenCalledWith({ __maicFitScrollBy: true }, '*');

    await report({ width: 1707, height: 1600 }, 0);
    expect(cue()).toBeNull();
  });

  it('yields the bottom edge to the runtime error banner', async () => {
    await renderHost();
    await report({ width: 1280, height: 1600 }, 880);
    await report({ width: 1707, height: 1600 }, 640);
    expect(cue()).not.toBeNull();
    await act(async () => {
      useSceneRuntimeErrors.getState().addError('scene-a', '[error] boom');
    });
    expect(document.querySelector('[data-testid="interactive-runtime-error"]')).not.toBeNull();
    expect(cue()).toBeNull();
  });
});
