// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InteractiveScene } from '@/lib/standalone-player/scenes/InteractiveScene';
import type { WidgetChannel } from '@/lib/standalone-player/playback/media-ports';
import {
  STANDALONE_PLAYER_STRING_KEYS,
  type StandalonePlayerStrings,
} from '@/lib/export/standalone-html/contract';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const strings = Object.fromEntries(
  STANDALONE_PLAYER_STRING_KEYS.map((key) => [key, `[${key}]`]),
) as StandalonePlayerStrings;

class StubResizeObserver {
  observe() {}
  disconnect() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('standalone InteractiveScene', () => {
  it('fills a slot taller than 16:9 with a grown logical viewport instead of letterboxing', () => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(480);
    const widgets = { attach: vi.fn(), markLoaded: vi.fn() } as unknown as WidgetChannel;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(InteractiveScene, { html: '<p>x</p>', title: 'T', strings, widgets }),
      );
    });

    const iframe = container.querySelector('iframe')!;
    const frame = iframe.parentElement!;
    expect(frame.style.left).toBe('0px');
    expect(frame.style.top).toBe('0px');
    expect(frame.style.width).toBe('640px');
    expect(frame.style.height).toBe('480px');
    expect(iframe.style.width).toBe('1280px');
    expect(iframe.style.height).toBe('960px');
    expect(iframe.style.transform).toBe('scale(0.5)');
    act(() => root.unmount());
  });
  it('shrinks a page whose content outgrows the frame and cues what is left below', () => {
    vi.stubGlobal('ResizeObserver', StubResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(640);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(360);
    const widgets = { attach: vi.fn(), markLoaded: vi.fn() } as unknown as WidgetChannel;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        createElement(InteractiveScene, { html: '<p>x</p>', title: 'T', strings, widgets }),
      );
    });
    const iframe = container.querySelector('iframe')!;
    const send = (height: number, scrollRemaining: number) =>
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            source: iframe.contentWindow,
            data: {
              __maicInteractive: true,
              kind: 'content-extent',
              viewportWidth: Number.parseFloat(iframe.style.width),
              viewportHeight: Number.parseFloat(iframe.style.height),
              contentWidth: 1280,
              contentHeight: height,
              scrollRemaining,
            },
          }),
        );
      });

    expect(iframe.style.transform).toBe('scale(0.5)');
    send(900, 180);
    expect(iframe.style.transform).toBe('scale(0.4)');
    expect(container.querySelector('[data-testid="interactive-more-below"]')).toBeNull();

    // The page reflowed and fits; then a section opens with more than the floor allows.
    send(900, 0);
    send(1600, 700);
    expect(iframe.style.transform).toBe('scale(0.375)');
    expect(container.querySelector('[data-testid="interactive-more-below"]')).toBeNull();
    send(1600, 640);
    expect(
      container.querySelector('[data-testid="interactive-more-below"]')?.textContent,
    ).toContain('[interactiveMoreBelow]');
    send(1600, 0);
    expect(container.querySelector('[data-testid="interactive-more-below"]')).toBeNull();
    act(() => root.unmount());
  });
});
