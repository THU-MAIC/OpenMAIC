import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PPTTextElement } from '../../dsl/src';
import { SlideElement } from '../src/SlideElement';

const textElement: PPTTextElement = {
  id: 'text-1',
  type: 'text',
  left: 24,
  top: 32,
  width: 120,
  height: 48,
  rotate: 0,
  content: '<p>Hello</p>',
  defaultFontName: 'Arial',
  defaultColor: '#111111',
};

describe('SlideElement', () => {
  it('keeps the full-slide root non-interactive and restores events on the visual element target', () => {
    const html = renderToStaticMarkup(
      createElement(SlideElement, {
        elementInfo: textElement,
        elementIndex: 3,
        onElementClick: vi.fn(),
      }),
    );

    expect(html).toContain('class="slide-element"');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('class="slide-element-hit-target"');
    expect(html).toContain('pointer-events:auto');
  });

  it('keeps read-only rendered elements non-interactive so parent cards can receive clicks', () => {
    const html = renderToStaticMarkup(
      createElement(SlideElement, {
        elementInfo: textElement,
        elementIndex: 3,
      }),
    );

    expect(html).toContain('class="slide-element"');
    expect(html).toContain('pointer-events:none');
    expect(html).toContain('class="slide-element-hit-target"');
    expect(html).not.toContain('pointer-events:auto');
  });
});
