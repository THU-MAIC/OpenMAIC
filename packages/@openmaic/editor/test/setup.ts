import '@testing-library/jest-dom/vitest';

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

if (typeof globalThis.Range !== 'undefined') {
  if (!globalThis.Range.prototype.getClientRects) {
    globalThis.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  }
  if (!globalThis.Range.prototype.getBoundingClientRect) {
    globalThis.Range.prototype.getBoundingClientRect = () => new DOMRect();
  }
}
