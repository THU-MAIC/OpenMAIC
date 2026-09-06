// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

describe('fresh iframe playback selector projection', () => {
  it('does not re-resolve an owner-projected selector or keep scheduling frames', () => {
    const patched = patchHtmlForIframe('<html><head></head><body></body></html>');
    const shim = patched.match(/<script data-iframe-element-picker-shim>([\s\S]*?)<\/script>/)?.[1];
    expect(shim).toBeTruthy();

    const component = document.createElement('section');
    component.id = 'component';
    document.body.appendChild(component);
    let frame: FrameRequestCallback | null = null;
    Object.defineProperty(window, 'requestAnimationFrame', {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      },
    });
    Object.defineProperty(window, 'cancelAnimationFrame', {
      configurable: true,
      value: vi.fn(),
    });
    const flushFrame = () => {
      const callback = frame;
      frame = null;
      callback?.(0);
    };

    new Function('window', 'document', shim as string)(window, document);
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: {
          type: 'element-picker:sync',
          mode: 'playback-stable-id',
          selectors: [],
          selectedSelector: '#component',
        },
      }),
    );

    expect(frame).not.toBeNull();
    flushFrame();

    expect(document.querySelector<HTMLElement>('[data-maic-picker-selected]')?.style.display).toBe(
      'none',
    );
    expect(frame).toBeNull();
  });
});
