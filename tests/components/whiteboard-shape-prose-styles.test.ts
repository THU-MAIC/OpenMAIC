import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  motion: { div: 'div' },
}));
vi.mock('@/components/slide-renderer/Editor/ScreenElement', () => ({
  ScreenElement: () =>
    createElement(
      'div',
      { className: 'screen-element' },
      createElement('div', { className: 'slide-renderer-prose' }),
    ),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

import { WhiteboardCanvas } from '@/components/whiteboard/whiteboard-canvas';

describe('whiteboard shape label styles', () => {
  it('includes the shared paragraph and list rules for its direct ScreenElement host', () => {
    const html = renderToStaticMarkup(
      createElement(WhiteboardCanvas, {
        whiteboard: {
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [{ id: 'shape-1', type: 'shape' }],
        } as never,
      }),
    );

    expect(html).toContain('class="whiteboard-screen-canvas');
    expect(html).toContain('class="screen-element"');
    expect(html).toContain('class="slide-renderer-prose"');
    expect(html).toContain('.whiteboard-screen-canvas .screen-element .slide-renderer-prose p {');
    expect(html).toContain('margin-bottom: var(--paragraphSpace, 0)');
    expect(html).toContain('list-style-type: disc !important');
    expect(html).toContain('list-style-type: decimal !important');
  });
});
