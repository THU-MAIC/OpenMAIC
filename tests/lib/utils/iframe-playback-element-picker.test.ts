// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { patchHtmlForIframe } from '@/lib/utils/iframe';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  delete (window as unknown as Record<string, unknown>).__maicElementPickerInstalled;
});

describe('iframe playback stable-ID picker shim', () => {
  it('selects the closest component root and keeps a sticky live-geometry outline', () => {
    const patched = patchHtmlForIframe('<html><head></head><body></body></html>');
    const shim = patched.match(/<script data-iframe-element-picker-shim>([\s\S]*?)<\/script>/)?.[1];
    expect(shim).toBeTruthy();

    const component = document.createElement('section');
    component.id = 'component';
    const child = document.createElement('span');
    child.textContent = 'Child';
    component.appendChild(child);
    const ineligible = document.createElement('div');
    const secondComponent = document.createElement('section');
    secondComponent.id = 'second-component';
    document.body.append(component, ineligible, secondComponent);
    let rect = { left: 20, top: 30, width: 160, height: 72 };
    component.getBoundingClientRect = () => rect as DOMRect;
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
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
        data: { type: 'element-picker:arm', mode: 'playback-stable-id' },
      }),
    );
    flushFrame();

    child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(postMessage).toHaveBeenCalledWith(
      {
        __maicInteractive: true,
        kind: 'element-picked',
        mode: 'playback-stable-id',
        selector: '#component',
      },
      '*',
    );
    expect(postMessage.mock.calls.at(-1)?.[0]).not.toHaveProperty('outerHTML');
    expect(postMessage.mock.calls.at(-1)?.[0]).not.toHaveProperty('text');
    secondComponent.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(postMessage).toHaveBeenCalledTimes(1);
    flushFrame();
    const selected = document.querySelector<HTMLElement>('[data-maic-picker-selected]');
    expect(selected?.style.display).toBe('block');

    ineligible.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(postMessage).toHaveBeenCalledTimes(1);

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
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { type: 'element-picker:disarm', mode: 'playback-stable-id' },
      }),
    );
    flushFrame();
    expect(selected?.style.display).toBe('block');
    expect(selected?.style.left).toBe('20px');

    rect = { left: 55, top: 65, width: 190, height: 90 };
    flushFrame();
    expect(selected?.style.left).toBe('55px');
    expect(selected?.style.top).toBe('65px');
    expect(selected?.style.width).toBe('190px');

    const duplicate = document.createElement('div');
    duplicate.id = 'component';
    document.body.appendChild(duplicate);
    flushFrame();
    expect(selected?.style.display).toBe('none');
    expect(frame).toBeNull();
    duplicate.remove();
    flushFrame();
    expect(selected?.style.display).toBe('none');

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { type: 'element-picker:arm', mode: 'playback-stable-id' },
      }),
    );
    child.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { type: 'element-picker:disarm', mode: 'playback-stable-id' },
      }),
    );
    flushFrame();
    expect(selected?.style.display).toBe('block');

    const replacement = document.createElement('section');
    replacement.id = 'component';
    component.replaceWith(replacement);
    flushFrame();
    expect(selected?.style.display).toBe('none');
    replacement.remove();
    document.body.appendChild(component);
    flushFrame();
    expect(selected?.style.display).toBe('none');

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        data: { type: 'element-picker:sync', mode: null, selectors: [], selectedSelector: null },
      }),
    );
    expect(document.querySelector('[data-maic-element-picker-overlay]')).toBeNull();
  });
});
