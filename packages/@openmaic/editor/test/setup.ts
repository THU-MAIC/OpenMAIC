import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Testing Library only unmounts automatically when the runner exposes a global
// `afterEach`, which this config does not. Without this, every tree a test
// mounts stays live until the file's environment is torn down, and React work
// still queued then (pointer events fired outside `act`) runs against a
// deleted `window` on a slow runner.
afterEach(() => {
  cleanup();
});

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
