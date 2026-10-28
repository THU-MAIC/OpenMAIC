// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useVisualViewport } from '@/lib/hooks/use-visual-viewport';
import { AdaptiveProvider, useMobileLayout } from '@/lib/adaptive/adaptive-provider';

let root: Root | undefined;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});
function mount(component: () => unknown) {
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div');
  root = createRoot(host);
  act(() => root!.render(createElement(component as () => null)));
  return host;
}
it('shares media listeners, updates consumers, and releases the last subscriber', () => {
  let matches = false;
  const listeners = new Set<() => void>();
  const add = vi.fn((_event, callback) => listeners.add(callback));
  const remove = vi.fn((_event, callback) => listeners.delete(callback));
  const matchMedia = vi.fn(() => ({
    get matches() {
      return matches;
    },
    addEventListener: add,
    removeEventListener: remove,
  }));
  vi.stubGlobal('matchMedia', matchMedia);
  function Consumer() {
    return createElement('span', null, String(useMediaQuery('(max-width: 1023px)')));
  }
  const host = mount(() =>
    createElement('div', null, createElement(Consumer), createElement(Consumer)),
  );
  expect(add).toHaveBeenCalledTimes(1);
  act(() => {
    matches = true;
    listeners.forEach((fn) => fn());
  });
  expect(host.textContent).toBe('truetrue');
  act(() => root!.unmount());
  root = undefined;
  expect(remove).toHaveBeenCalledTimes(1);
});
it('renders server hints without accessing browser APIs', () => {
  function Consumer() {
    return createElement('span', null, String(useMobileLayout()));
  }
  expect(
    renderToString(
      createElement(AdaptiveProvider, { initialMobileLayout: true }, createElement(Consumer)),
    ),
  ).toContain('true');
  expect(
    renderToString(createElement(() => createElement('span', null, String(useVisualViewport())))),
  ).toContain('null');
});
it('reads visible viewport changes and cancels listeners on unmount', () => {
  const viewport = new EventTarget() as EventTarget & {
    width: number;
    height: number;
    offsetTop: number;
    offsetLeft: number;
    scale: number;
  };
  Object.assign(viewport, { width: 390, height: 700, offsetTop: 0, offsetLeft: 0, scale: 1 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
  const remove = vi.spyOn(viewport, 'removeEventListener');
  const host = mount(() => createElement('span', null, JSON.stringify(useVisualViewport())));
  expect(host.textContent).toContain('700');
  act(() => {
    viewport.height = 350;
    viewport.offsetTop = 20;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(host.textContent).toContain('350');
  expect(host.textContent).toContain('20');
  act(() => root!.unmount());
  root = undefined;
  expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
});
it('corrects the server hint after hydration without a hydration mismatch', async () => {
  const { hydrateRoot } = await import('react-dom/client');
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  function Consumer() {
    return createElement('span', null, String(useMobileLayout()));
  }
  const tree = createElement(
    AdaptiveProvider,
    { initialMobileLayout: true },
    createElement(Consumer),
  );
  const host = document.createElement('div');
  host.innerHTML = renderToString(tree);
  expect(host.textContent).toBe('true');
  const onRecoverableError = vi.fn();
  await act(async () => {
    root = hydrateRoot(host, tree, { onRecoverableError });
  });
  expect(host.textContent).toBe('false');
  expect(onRecoverableError).not.toHaveBeenCalled();
});
it('falls back to window geometry and coalesces resize events', () => {
  vi.stubGlobal('visualViewport', undefined);
  let callback: FrameRequestCallback | undefined;
  const request = vi.fn((fn: FrameRequestCallback) => {
    callback = fn;
    return 42;
  });
  const cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request);
  vi.stubGlobal('cancelAnimationFrame', cancel);
  const host = mount(() => createElement('span', null, JSON.stringify(useVisualViewport())));
  expect(JSON.parse(host.textContent!)).toMatchObject({
    width: window.innerWidth,
    offsetTop: 0,
    scale: 1,
  });
  act(() => {
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
  });
  expect(request).toHaveBeenCalledTimes(1);
  act(() => callback!(0));
  act(() => window.dispatchEvent(new Event('resize')));
  act(() => root!.unmount());
  root = undefined;
  expect(cancel).toHaveBeenCalledWith(42);
});
