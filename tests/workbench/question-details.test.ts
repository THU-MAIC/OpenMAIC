// @vitest-environment jsdom
/**
 * The clamped `details` block offers its expand toggle exactly when the text
 * overflows — including after a resize made text that once fit overflow.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QuestionDetails } from '@/components/workbench/chat/question-details';

let root: Root;
let container: HTMLDivElement;
let resize: (() => void) | null;
let disconnected: number;
let scrollHeight: number;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resize = null;
  disconnected = 0;
  scrollHeight = 40;
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resize = callback;
      }
      observe() {}
      disconnect() {
        disconnected += 1;
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(() => scrollHeight);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => 100);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const toggle = () => container.querySelector('button');

describe('QuestionDetails', () => {
  it('re-measures on resize, and stops observing once unmounted', async () => {
    await act(async () => root.render(createElement(QuestionDetails, { text: 'A short plan' })));
    // Fits: no toggle.
    expect(toggle()).toBeNull();
    // The pane narrows and the same text now overflows.
    scrollHeight = 300;
    await act(async () => resize?.());
    expect(toggle()).not.toBeNull();
    await act(async () => root.unmount());
    expect(disconnected).toBeGreaterThan(0);
  });

  it('measures once without ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    scrollHeight = 300;
    await act(async () => root.render(createElement(QuestionDetails, { text: 'A long plan' })));
    expect(toggle()).not.toBeNull();
    await act(async () => root.unmount());
  });
});
