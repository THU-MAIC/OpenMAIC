// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { PPTShapeElement } from '@openmaic/dsl';
import { shapeToTextFallback } from '@openmaic/geometry';
import { BaseShapeElement } from '../src/elements/shape/BaseShapeElement';
import { BaseTextElement } from '../src/elements/text/BaseTextElement';

const shape: PPTShapeElement = {
  type: 'shape',
  id: 'bad',
  left: 50,
  top: 70,
  width: 320,
  height: 150,
  viewBox: [320, 150],
  path: 'M0 0 Z1 1',
  rotate: 45,
  fill: '#111827',
  fixedRatio: false,
  text: {
    content: '<p>Recovered label</p>',
    align: 'middle',
    defaultFontName: 'Arial',
    defaultColor: '#fff',
  },
};

describe('historical shape text projection', () => {
  it('uses exactly the same text renderer as a generated fallback', () => {
    const historical = renderToStaticMarkup(
      createElement(BaseShapeElement, { elementInfo: shape }),
    );
    const generated = renderToStaticMarkup(
      createElement(BaseTextElement, { elementInfo: shapeToTextFallback(shape)! }),
    );
    expect(historical).toBe(`<div data-shape-geometry-error="syntax">${generated}</div>`);
    expect(historical).not.toContain('<svg');
  });

  it('keeps the shape-label editing slot bound to the original historical element', () => {
    let target: PPTShapeElement | undefined;
    const html = renderToStaticMarkup(
      createElement(BaseShapeElement, {
        elementInfo: shape,
        renderLabel: (element) => {
          target = element;
          return 'Editing original label';
        },
      }),
    );
    expect(target).toBe(shape);
    expect(html).toContain('Editing original label');
  });

  it('can switch between valid geometry and text recovery without changing hook order', () => {
    const { container, rerender } = render(
      createElement(BaseShapeElement, { elementInfo: { ...shape, path: 'M0 0 L100 100' } }),
    );
    expect(container.querySelector('.base-element-shape')).not.toBeNull();
    rerender(createElement(BaseShapeElement, { elementInfo: shape }));
    expect(container.querySelector('.base-element-text')).not.toBeNull();
    expect(container.querySelector('svg')).toBeNull();
    rerender(createElement(BaseShapeElement, { elementInfo: { ...shape, path: 'M0 0 L100 100' } }));
    expect(container.querySelector('.base-element-shape')).not.toBeNull();
  });
});

describe('valid shape label insets', () => {
  const validShape = { ...shape, path: 'M0 0 L100 100' };

  it.each([
    '<div data-pptx-text-insets="true" style="padding: 0pt"><p>Imported</p></div>',
    '<div style="padding: 4pt 8pt"><p>Legacy imported</p></div>',
  ])('uses imported label insets without an additional shape inset: %s', (content) => {
    const { container } = render(
      createElement(BaseShapeElement, {
        elementInfo: { ...validShape, text: { ...shape.text!, content } },
      }),
    );
    expect((container.querySelector('.shape-text') as HTMLElement).style.padding).toBe('0px');
  });

  it('keeps the default inset for an authored shape label', () => {
    const { container } = render(createElement(BaseShapeElement, { elementInfo: validShape }));
    expect((container.querySelector('.shape-text') as HTMLElement).style.padding).toBe('10px');
  });

  it('does not treat a nested PPTX marker as an outer label inset', () => {
    const { container } = render(
      createElement(BaseShapeElement, {
        elementInfo: {
          ...validShape,
          text: {
            ...shape.text!,
            content: '<div><div data-pptx-text-insets="true">Nested</div></div>',
          },
        },
      }),
    );
    expect((container.querySelector('.shape-text') as HTMLElement).style.padding).toBe('10px');
  });

  it('does not mistake data-style for an inline style attribute', () => {
    const { container } = render(
      createElement(BaseShapeElement, {
        elementInfo: {
          ...validShape,
          text: { ...shape.text!, content: '<div data-style="padding: 0">Label</div>' },
        },
      }),
    );
    expect((container.querySelector('.shape-text') as HTMLElement).style.padding).toBe('10px');
  });
});
