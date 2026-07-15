/**
 * Shared test setup. jsdom does not implement ResizeObserver, which the v1
 * SlideCanvas depends on via `useViewportSize`; provide a no-op polyfill so
 * component tests that mount SlideCanvas (e.g. EditableSlideCanvas) can render.
 * Harmless under the node environment used by the pure-core tests.
 */
if (typeof globalThis.ResizeObserver === 'undefined') {
  class ResizeObserverStub {
    constructor(callback: ResizeObserverCallback) {
      void callback;
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
}
