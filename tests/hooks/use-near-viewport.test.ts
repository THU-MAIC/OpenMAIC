// @vitest-environment jsdom
import { createElement, createRef, type RefObject } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useNearViewport } from '@/lib/hooks/use-near-viewport';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type IOCallback = (entries: Array<Partial<IntersectionObserverEntry>>) => void;

let observedCallback: IOCallback | undefined;
let observedOptions: IntersectionObserverInit | undefined;
const observeMock = vi.fn();
const disconnectMock = vi.fn();

class FakeIntersectionObserver {
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    observedCallback = (entries) =>
      callback(entries as IntersectionObserverEntry[], this as unknown as IntersectionObserver);
    observedOptions = options;
  }
  observe = observeMock;
  unobserve = vi.fn();
  disconnect = disconnectMock;
  root = null;
  rootMargin = '';
  thresholds = [];
  takeRecords = () => [];
}

function Probe({ targetRef }: { readonly targetRef: RefObject<HTMLDivElement | null> }) {
  const visible = useNearViewport(targetRef);
  return createElement(
    'div',
    { ref: targetRef },
    createElement('output', { 'data-testid': 'state' }, visible ? 'visible' : 'hidden'),
  );
}

function mount(): { root: Root; targetRef: RefObject<HTMLDivElement | null> } {
  const container = document.createElement('div');
  document.body.append(container);
  const targetRef = createRef<HTMLDivElement>();
  const root = createRoot(container);
  act(() => root.render(createElement(Probe, { targetRef })));
  return { root, targetRef };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  observedCallback = undefined;
  observedOptions = undefined;
});

describe('useNearViewport', () => {
  it('stays hidden until the observer reports the element near the viewport', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    const container = mount();

    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('hidden');
    expect(observeMock).toHaveBeenCalledOnce();
    expect(observedOptions?.rootMargin).toBe('200px 0px');

    act(() => observedCallback?.([{ isIntersecting: true }]));
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('visible');

    act(() => observedCallback?.([{ isIntersecting: false }]));
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('hidden');

    act(() => container.root.unmount());
    expect(disconnectMock).toHaveBeenCalledOnce();
  });

  it('falls back to always-visible when IntersectionObserver is unavailable', async () => {
    mount();
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('hidden');
    // The fallback flips on a microtask so the effect never synchronously re-renders.
    await act(async () => {});
    expect(document.querySelector('[data-testid="state"]')?.textContent).toBe('visible');
  });
});
