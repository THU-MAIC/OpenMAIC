import { describe, expect, it } from 'vitest';
import type { PPTShapeElement } from '@openmaic/dsl';
import { shapeToTextFallback } from '../src/index.js';

const shape: PPTShapeElement = {
  type: 'shape',
  id: 'broken',
  left: 50,
  top: 70,
  width: 320,
  height: 150,
  viewBox: [320, 150],
  path: 'M0 0 Z1 1',
  rotate: 45,
  fill: '#111827',
  fixedRatio: false,
  groupId: 'group',
  lock: true,
  name: 'label',
  opacity: 0,
  link: { type: 'web', target: 'https://example.com' },
  text: {
    content: '<p>Label</p>',
    defaultFontName: 'Arial',
    defaultColor: '#fff',
    align: 'bottom',
    lineHeight: 2,
    wordSpace: 8,
    paragraphSpace: 30,
  },
};

describe('shared shape-to-text fallback', () => {
  it('preserves label styles, metadata and visibility without retaining shape geometry', () => {
    const before = structuredClone(shape);
    const fallback = shapeToTextFallback(shape);
    expect(fallback).toMatchObject({
      type: 'text',
      id: shape.id,
      left: 50,
      top: 70,
      width: 320,
      height: 150,
      rotate: 45,
      groupId: 'group',
      lock: true,
      name: 'label',
      link: shape.link,
      opacity: 0,
      vAlign: 'bottom',
      content: '<p>Label</p>',
      defaultFontName: 'Arial',
      defaultColor: '#fff',
      lineHeight: 2,
      wordSpace: 8,
      paragraphSpace: 30,
    });
    expect(fallback).not.toHaveProperty('path');
    expect(fallback).not.toHaveProperty('viewBox');
    expect(shape).toEqual(before);
    expect(fallback!.fill).toBe('rgb(17, 24, 39)');
  });

  it.each([0, -1, NaN, Infinity, 1e100])('bounds invalid/oversized dimensions %s', (width) => {
    const fallback = shapeToTextFallback({ ...shape, width, left: Infinity, top: NaN })!;
    expect(fallback.width).toBeGreaterThan(0);
    expect(fallback.width).toBeLessThanOrEqual(4000);
    expect(fallback).toMatchObject({ left: 0, top: 0 });
  });

  it('provides a dark backdrop for white labels on transparent shapes', () => {
    const fallback = shapeToTextFallback({ ...shape, fill: 'transparent' })!;
    expect(fallback.fill).toBe('rgb(17, 24, 39)');
  });

  it.each([undefined, NaN, Infinity])(
    'uses the shape label default line height when the override is %s',
    (lineHeight) => {
      const fallback = shapeToTextFallback({
        ...shape,
        text: { ...shape.text!, lineHeight },
      });
      expect(fallback?.lineHeight).toBe(1.625);
    },
  );

  it.each([
    '',
    '  ',
    '<p></p>',
    '<p>&nbsp;</p>',
    '<p>&#32;</p>',
    '<p>&#x20;</p>',
    '<p>&#9;</p>',
    '<p>&ensp;&emsp;&thinsp;&Tab;&NewLine;</p>',
    '<!-- <span data-inline-math="x^2"></span> -->',
    '<!-- <math></math><img src="unused.png"> -->',
  ])('omits empty labels: %s', (content) => {
    expect(shapeToTextFallback({ ...shape, text: { ...shape.text!, content } })).toBeNull();
  });

  it('retains inline math even when its source lives in an attribute', () => {
    expect(
      shapeToTextFallback({
        ...shape,
        text: { ...shape.text!, content: '<span data-inline-math="x^2"></span>' },
      }),
    ).not.toBeNull();
  });
  it('retains visible entities as text without mistaking them for markup', () => {
    const content = '<p>&lt;img&gt; &amp; &#65;</p>';
    expect(shapeToTextFallback({ ...shape, text: { ...shape.text!, content } })?.content).toBe(
      content,
    );
  });
  it('does not copy an invalid model-provided label type into the text element', () => {
    const malformed = {
      ...shape,
      text: { ...shape.text!, type: { bad: true } },
    } as unknown as PPTShapeElement;
    expect(shapeToTextFallback(malformed)).not.toHaveProperty('textType');
    expect(
      shapeToTextFallback({ ...shape, text: { ...shape.text!, type: 'itemTitle' } }),
    ).toHaveProperty('textType', 'itemTitle');
  });
  it('copies only supported hyperlink fields from malformed source data', () => {
    const malformed = {
      ...shape,
      link: { type: 'web', target: 'https://example.com', unexpected: { bad: true } },
    } as unknown as PPTShapeElement;
    expect(shapeToTextFallback(malformed)?.link).toEqual({
      type: 'web',
      target: 'https://example.com',
    });
  });
});
