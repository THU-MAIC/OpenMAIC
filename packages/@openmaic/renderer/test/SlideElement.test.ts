import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { PPTAudioElement, PPTShapeElement, PPTTextElement } from '../../dsl/src';
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

const audioElement: PPTAudioElement = {
  id: 'audio-1',
  type: 'audio',
  left: 24,
  top: 32,
  width: 240,
  height: 64,
  rotate: 0,
  fixedRatio: true,
  color: '#7c3aed',
  loop: false,
  autoplay: false,
  src: 'lesson.mp3',
};

const shapeElement: PPTShapeElement = {
  id: 'shape-1',
  type: 'shape',
  left: 24,
  top: 32,
  width: 120,
  height: 48,
  rotate: 0,
  viewBox: [100, 100],
  path: 'M 0 0 L 100 0 L 100 100 L 0 100 Z',
  fixedRatio: false,
  fill: '#ffffff',
  text: {
    content: 'First line\nSecond line',
    align: 'middle',
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  },
};

describe('SlideElement', () => {
  it('preserves literal line endings in shape labels', () => {
    const html = renderToStaticMarkup(
      createElement(SlideElement, { elementInfo: shapeElement, elementIndex: 3 }),
    );

    expect(html).toContain('white-space:pre-line');
  });

  it('does not preserve source-formatting line endings in rich shape labels', () => {
    const html = renderToStaticMarkup(
      createElement(SlideElement, {
        elementInfo: {
          ...shapeElement,
          text: { ...shapeElement.text!, content: '<p>First line</p>\n<p>Second line</p>' },
        },
        elementIndex: 3,
      }),
    );

    expect(html).not.toContain('white-space:pre-line');
  });

  it('does not apply literal-line-ending styling to injected shape-label editor content', () => {
    const html = renderToStaticMarkup(
      createElement(SlideElement, {
        elementInfo: shapeElement,
        elementIndex: 3,
        renderShapeLabel: () => createElement('div', { 'data-shape-label-editor': '' }),
      }),
    );

    expect(html).toContain('data-shape-label-editor=""');
    expect(html).not.toContain('white-space:pre-line');
  });

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

  it('routes Audio elements through the renderer content layer', () => {
    const html = renderToStaticMarkup(
      createElement(SlideElement, { elementInfo: audioElement, elementIndex: 3 }),
    );

    expect(html).toContain('base-element-audio');
    expect(html).toContain('Play audio');
    expect(html).not.toContain('lesson.mp3');
  });
});
