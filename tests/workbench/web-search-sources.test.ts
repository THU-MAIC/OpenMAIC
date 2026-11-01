// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { WebSearchVisualizer } from '@/components/generation/step-visualizers';

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const sources = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ title: `query ${i + 1}`, url: 'Web search' }));

describe('the research list in the preview', () => {
  it('lists every entry in a scrolling list with the newest highlighted', async () => {
    await act(async () =>
      root.render(createElement(WebSearchVisualizer, { sources: sources(7), scrollable: true })),
    );
    const list = container.querySelector('[data-testid="web-search-sources"]');
    expect(list?.children).toHaveLength(7);
    expect(list?.querySelector('[data-newest="true"]')?.textContent).toContain('query 7');
    // The count shows the total, not only what is in view.
    expect(container.textContent).toContain('7');
  });

  it('keeps the classic first-four view by default', async () => {
    await act(async () => root.render(createElement(WebSearchVisualizer, { sources: sources(7) })));
    expect(container.querySelector('[data-testid="web-search-sources"]')).toBeNull();
    expect(container.textContent).not.toContain('query 5');
  });

  it('puts the reader back at the newest when the hidden preview is shown again', async () => {
    let onResize: (() => void) | null = null;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(callback: () => void) {
          onResize = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    // jsdom lays nothing out: a list 100px tall over 400px of entries.
    let height = 100;
    let top = 0;
    const layout = (el: Element) => {
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => height });
      Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => 400 });
      Object.defineProperty(el, 'scrollTop', {
        configurable: true,
        get: () => top,
        // Like a browser: a list that is not laid out cannot be scrolled.
        set: (value: number) => {
          if (height > 0) top = value;
        },
      });
      Object.defineProperty(el, 'scrollTo', {
        configurable: true,
        value: ({ top: next }: { top: number }) => {
          if (height > 0) top = next;
        },
      });
    };
    await act(async () =>
      root.render(createElement(WebSearchVisualizer, { sources: sources(7), scrollable: true })),
    );
    const list = container.querySelector('[data-testid="web-search-sources"]')!;
    layout(list);
    // Hidden: the layout, and with it the scroll position, is gone.
    height = 0;
    top = 0;
    await act(async () => onResize?.());
    // A source arrives while hidden: nothing to read, nothing lost.
    await act(async () =>
      root.render(createElement(WebSearchVisualizer, { sources: sources(8), scrollable: true })),
    );
    // Shown again: back at the newest.
    height = 100;
    await act(async () => onResize?.());
    expect(top).toBe(400);
    vi.unstubAllGlobals();
  });
});
