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

// ProseMirror reads Range geometry when it scrolls a restored selection into
// view. jsdom has no layout engine, so expose stable empty geometry in tests.
if (typeof globalThis.Range !== 'undefined') {
  if (!globalThis.Range.prototype.getClientRects) {
    globalThis.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!globalThis.Range.prototype.getBoundingClientRect) {
    globalThis.Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
}
