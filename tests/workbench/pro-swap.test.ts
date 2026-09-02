import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installBrowser(finished = deferred<void>()) {
  let routeUpdate: Promise<void> | undefined;
  const root = {
    setAttribute: vi.fn(),
    removeAttribute: vi.fn(),
  };
  const skipTransition = vi.fn(() => finished.resolve());
  const startViewTransition = vi.fn((callback: () => void | Promise<void>) => {
    routeUpdate = Promise.resolve(callback());
    return { finished: finished.promise, ready: Promise.resolve(), skipTransition };
  });
  vi.stubGlobal('window', {
    location: { origin: 'http://localhost' },
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal('document', { documentElement: root, startViewTransition });
  return {
    finished,
    root,
    routeUpdate: () => routeUpdate,
    skipTransition,
    startViewTransition,
  };
}

describe('Pro route swap', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('falls back to immediate navigation when View Transitions are unavailable', async () => {
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost' },
      matchMedia: () => ({ matches: false }),
    });
    vi.stubGlobal('document', { documentElement: {} });
    const push = vi.fn();
    const { isProSwapRunning, startProSwap } = await import('@/lib/workbench/pro-swap');

    startProSwap('/workspace', push);

    expect(push).toHaveBeenCalledWith('/workspace');
    expect(isProSwapRunning()).toBe(false);
  });

  it.each([
    ['success', 'resolve'],
    ['skip', 'skip'],
    ['abort', 'reject'],
  ] as const)('removes data-pro-swap when the transition ends by %s', async (_label, ending) => {
    const browser = installBrowser();
    const push = vi.fn();
    const { isProSwapRunning, proSwapArrived, startProSwap } =
      await import('@/lib/workbench/pro-swap');

    startProSwap('/workspace?session=example', push);
    expect(browser.root.setAttribute).toHaveBeenCalledWith('data-pro-swap', 'enter');
    expect(push).toHaveBeenCalledWith('/workspace?session=example');
    expect(isProSwapRunning()).toBe(true);

    proSwapArrived('/workspace');
    await browser.routeUpdate();
    if (ending === 'skip') browser.skipTransition();
    else if (ending === 'reject') browser.finished.reject(new Error('transition aborted'));
    else browser.finished.resolve();
    await browser.finished.promise.catch(() => undefined);
    await Promise.resolve();

    // This is the half-faded-page regression guard: every completion path
    // must remove the attribute that assigns shared view-transition names.
    expect(browser.root.removeAttribute).toHaveBeenCalledWith('data-pro-swap');
    expect(isProSwapRunning()).toBe(false);
  });

  it('marks a transition back to classic as an exit', async () => {
    const browser = installBrowser();
    const { proSwapArrived, startProSwap } = await import('@/lib/workbench/pro-swap');

    startProSwap('/', vi.fn());
    expect(browser.root.setAttribute).toHaveBeenCalledWith('data-pro-swap', 'exit');
    proSwapArrived('/');
    await browser.routeUpdate();
    browser.finished.resolve();
    await browser.finished.promise;
  });

  it('drops a second swap while the first is running instead of queueing it', async () => {
    const browser = installBrowser();
    const push = vi.fn();
    const { proSwapArrived, startProSwap } = await import('@/lib/workbench/pro-swap');

    startProSwap('/workspace', push);
    startProSwap('/workspace', push);

    expect(browser.startViewTransition).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledOnce();
    proSwapArrived('/workspace');
    await browser.routeUpdate();
    browser.finished.resolve();
    await browser.finished.promise;
  });

  it('settles the frozen-frame callback after the route-arrival timeout', async () => {
    vi.useFakeTimers();
    const browser = installBrowser();
    const push = vi.fn();
    const { isProSwapRunning, startProSwap } = await import('@/lib/workbench/pro-swap');

    startProSwap('/workspace', push);
    const update = browser.routeUpdate();
    let settled = false;
    update?.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(599);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe(true);
    expect(push).toHaveBeenCalledOnce();

    // The route update is no longer frozen, but ownership lasts until the View
    // Transition API itself finishes; cleanup then removes the morph attribute.
    expect(isProSwapRunning()).toBe(true);
    browser.finished.resolve();
    await browser.finished.promise;
    await Promise.resolve();
    expect(browser.root.removeAttribute).toHaveBeenCalledWith('data-pro-swap');
    expect(isProSwapRunning()).toBe(false);
  });

  it('respects reduced-motion preference', async () => {
    const startViewTransition = vi.fn();
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost' },
      matchMedia: () => ({ matches: true }),
    });
    vi.stubGlobal('document', { documentElement: {}, startViewTransition });
    const push = vi.fn();
    const { startProSwap } = await import('@/lib/workbench/pro-swap');

    startProSwap('/workspace', push);

    expect(push).toHaveBeenCalledWith('/workspace');
    expect(startViewTransition).not.toHaveBeenCalled();
  });
});
