import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PPTShapeElement } from '@openmaic/dsl';

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  motion: { div: 'div' },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
const scene = vi.hoisted(() => ({ content: undefined as unknown }));
vi.mock('@/lib/contexts/scene-context', () => ({
  useSceneData: () => ({ sceneId: 'scene-1' }),
  useSceneSelector: (selector: (content: unknown) => unknown) => selector(scene.content),
}));

import { WhiteboardCanvas } from '@/components/whiteboard/whiteboard-canvas';

const shape: PPTShapeElement = {
  id: 'shape-1',
  type: 'shape',
  left: 20,
  top: 20,
  width: 200,
  height: 100,
  rotate: 0,
  viewBox: [200, 100],
  path: 'M 0 0 L 200 0 L 200 100 L 0 100 Z',
  fill: '#eeeeee',
  fixedRatio: false,
  text: {
    content: '<ul><li>First</li></ul><p>Second</p>',
    align: 'middle',
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  },
};

const render = () =>
  renderToStaticMarkup(
    createElement(WhiteboardCanvas, {
      whiteboard: { id: 'wb-1', viewportSize: 1000, viewportRatio: 0.5625, elements: [shape] },
    }),
  );

describe('whiteboard shape label styles', () => {
  it('includes the shared paragraph and list rules for its renderer elements', () => {
    scene.content = undefined;
    const html = render();

    expect(html).toContain('class="whiteboard-screen-canvas');
    expect(html).toContain('class="slide-element"');
    expect(html).toContain('slide-renderer-prose');
    expect(html).toContain('.slide-renderer-prose p {');
    expect(html).toContain('margin-bottom: var(--paragraphSpace, 0)');
    expect(html).toContain('list-style-type: disc !important');
    expect(html).toContain('list-style-type: decimal !important');
  });

  it('gives uncolored text the slide theme, not the app theme', () => {
    scene.content = {
      type: 'slide',
      canvas: { id: 'slide-1', theme: { fontColor: '#123456', fontName: 'Slide Font' } },
    };
    expect(render()).toMatch(
      /class="slide-element"[^>]*style="[^"]*color:#123456;font-family:Slide Font/,
    );
  });

  it('falls back to the default slide text without a theme', () => {
    scene.content = { type: 'slide', canvas: { id: 'slide-1' } };
    expect(render()).toMatch(
      /class="slide-element"[^>]*style="[^"]*color:#333333;font-family:Microsoft YaHei/,
    );
  });
});
